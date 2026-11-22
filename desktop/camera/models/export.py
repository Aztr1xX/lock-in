"""Exports the candidate camera models to ONNX for the speed test (camera plan, step 1).

Runs in GitHub Actions (.github/workflows/camera-models.yml), never on a user's PC:

    python export.py OUT_DIR

Writes into OUT_DIR:
  *.onnx          the candidate models, fixed input sizes
  manifest.json   what each file is, how to feed it, and which ones make up a full check
  reference.json  what each model's official pipeline finds in bus.jpg, so the Rust speed test can
                  prove its own resizing and decoding give the same answers
  bus.jpg         the test picture (from the ultralytics package; only used by CI, never shipped)

Licences: RF-DETR Nano, D-FINE Nano, YOLOX, NanoDet-Plus and RTMPose-s are Apache 2.0. YOLO26n is
AGPL-3.0 and is only here to be timed against the others; it must not end up in a shipped detector.

Models marked timing_only are timed in CI but left out of the app, to keep the installer small.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
TMP = Path(tempfile.mkdtemp())

models: list[dict] = []
reference: dict[str, list] = {}
problems: list[str] = []

COCO80 = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
    "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def add(id_: str, src: Path, family: str, size: int | tuple[int, int], label: str, licence: str, **extra):
    """Copies one model into OUT and lists it. size is the input width and height (or one number if square)."""
    w, h = size if isinstance(size, tuple) else (size, size)
    dst = OUT / f"{id_}.onnx"
    shutil.copyfile(src, dst)
    models.append(
        dict(id=id_, file=dst.name, family=family, width=w, height=h, label=label, licence=licence,
             bytes=dst.stat().st_size, sha256=sha256(dst), **extra)
    )
    print(f"  {dst.name}: {dst.stat().st_size / 1e6:.1f} MB", flush=True)


def step(name):
    """Runs one export; a failure is recorded and the others still run."""
    def wrap(fn):
        print(f"== {name}", flush=True)
        try:
            fn()
        except Exception:
            traceback.print_exc()
            problems.append(name)
        return fn
    return wrap


def dets(rows):
    """Keeps reference detections worth comparing: score 0.3 and up, rounded."""
    out = [dict(cls=c, score=round(float(s), 4), box=[round(float(v), 1) for v in b]) for c, s, b in rows if s >= 0.3]
    return sorted(out, key=lambda d: -d["score"])


# ---------- test picture ----------
import ultralytics  # noqa: E402

bus = Path(ultralytics.__file__).parent / "assets" / "bus.jpg"
shutil.copyfile(bus, OUT / "bus.jpg")
BUS = Image.open(bus).convert("RGB")


@step("RF-DETR Nano")
def rfdetr():
    from rfdetr import RFDETRNano
    from rfdetr.assets.coco_classes import COCO_CLASSES

    m = RFDETRNano()
    for size in (384, 320):
        path = Path(m.export(output_dir=str(TMP / f"rfdetr{size}"), shape=(size, size), verbose=False))
        if path.is_dir():
            path = next(path.glob("*.onnx"))
        # Each size carries its own 108 MB copy of the weights, so only 384 ships in the app;
        # 320 is timed in CI to see what a smaller hands crop would save.
        add(f"rfdetr-n-{size}", path, "rfdetr", size, "RF-DETR Nano", "Apache-2.0", **({} if size == 384 else {"timing_only": True}))

    found = m.predict(BUS, threshold=0.3)
    reference["rfdetr-n-384"] = dets(
        (COCO_CLASSES.get(int(c), str(c)), s, b) for c, s, b in zip(found.class_id, found.confidence, found.xyxy)
    )

    # 8-bit weights for the matrix multiplies, quantised on the fly: a cheap way to see how much
    # faster the transformer gets on a CPU before deciding whether proper int8 training is worth it.
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q = TMP / "rfdetr-n-384-int8.onnx"
    quantize_dynamic(OUT / "rfdetr-n-384.onnx", q, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
    add("rfdetr-n-384-int8", q, "rfdetr", 384, "RF-DETR Nano, 8-bit", "Apache-2.0", cpu_only=True, timing_only=True)


@step("D-FINE Nano")
def dfine():
    import torch
    from transformers import AutoImageProcessor, DFineForObjectDetection

    repo = None
    for candidate in ("ustc-community/dfine_n_coco", "ustc-community/dfine-nano-coco"):
        try:
            model = DFineForObjectDetection.from_pretrained(candidate).eval()
            repo = candidate
            break
        except Exception as e:  # try the next name
            print(f"  {candidate}: {e}")
    if repo is None:
        raise RuntimeError("D-FINE Nano weights not found on Hugging Face")

    class Wrapped(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            o = self.m(pixel_values=pixel_values)
            return o.logits, o.pred_boxes

    for size in (416, 320):
        path = TMP / f"dfine{size}.onnx"
        torch.onnx.export(
            Wrapped(model), torch.zeros(1, 3, size, size), str(path), input_names=["pixel_values"],
            output_names=["logits", "pred_boxes"], opset_version=17, dynamo=False,
        )
        # The traced graph computes its position embeddings from the input shape with float64
        # maths that ONNX Runtime can't run; the shape is fixed, so fold them into constants.
        import onnxslim

        slim = TMP / f"dfine{size}-slim.onnx"
        onnxslim.slim(str(path), str(slim))
        # Three times over the time budget on GitHub's CPU (first CI run), so CI-only from now on.
        add(f"dfine-n-{size}", slim, "dfine", size, "D-FINE Nano", "Apache-2.0", timing_only=True)

    proc = AutoImageProcessor.from_pretrained(repo)
    # Set on the processor itself: passed as an argument, some versions keep their own 640 px.
    proc.size = {"height": 416, "width": 416}
    inputs = proc(images=BUS, return_tensors="pt")
    assert tuple(inputs["pixel_values"].shape[-2:]) == (416, 416), inputs["pixel_values"].shape
    with torch.no_grad():
        out = model(**inputs)
    res = proc.post_process_object_detection(out, target_sizes=[(BUS.height, BUS.width)], threshold=0.3)[0]
    reference["dfine-n-416"] = dets(
        (model.config.id2label[int(c)], s, b) for c, s, b in zip(res["labels"], res["scores"], res["boxes"])
    )


@step("YOLO26n (timing only, AGPL)")
def yolo():
    from ultralytics import YOLO

    for size in (416, 320):
        # nms=False keeps YOLO26's NMS-free head: 300 rows of x1, y1, x2, y2, score, class.
        path = Path(YOLO("yolo26n.pt").export(format="onnx", imgsz=size, opset=17, simplify=True, nms=False))
        moved = TMP / f"yolo26n-{size}.onnx"
        shutil.move(path, moved)
        add(f"yolo26n-{size}", moved, "yolo26", size, "YOLO26n", "AGPL-3.0", timing_only=True)

    r = YOLO(str(OUT / "yolo26n-416.onnx"), task="detect").predict(BUS, imgsz=416, conf=0.3, verbose=False)[0]
    reference["yolo26n-416"] = dets(
        (r.names[int(c)], s, b) for c, s, b in zip(r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())
    )


# ---------- Apache 2.0 CNN detectors with ready-made ONNX files on GitHub ----------
# Both official demos read pictures with OpenCV (BGR) and resize with INTER_LINEAR.
import cv2  # noqa: E402

BUS_BGR = cv2.imread(str(bus))


def fetch(url: str) -> Path:
    dst = TMP / url.rsplit("/", 1)[1]
    urllib.request.urlretrieve(url, dst)
    return dst


def nms(boxes, scores, thr):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])  # noqa: E731
        order = rest[inter / (area(boxes[i]) + area(boxes[rest]) - inter) <= thr]
    return keep


def multiclass_nms(boxes, scores, nms_thr, score_thr=0.3):
    """Class-by-class NMS, as in YOLOX's demo utils and NanoDet's post-processing."""
    out = []
    for c in range(scores.shape[1]):
        m = scores[:, c] > score_thr
        if m.any():
            b, s = boxes[m], scores[m, c]
            out += [(COCO80[c], s[k], b[k]) for k in nms(b, s, nms_thr)]
    return out


def run_onnx(path: Path, x: np.ndarray) -> np.ndarray:
    s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return s.run(None, {s.get_inputs()[0].name: x})[0][0]


YOLOX_URL = "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_{}.onnx"


@step("YOLOX Nano and Tiny")
def yolox():
    for name, label, extra in (("nano", "YOLOX Nano", {}), ("tiny", "YOLOX Tiny", {"timing_only": True})):
        add(f"yolox-{name}-416", fetch(YOLOX_URL.format(name)), "yolox", 416, label, "Apache-2.0", **extra)
        # Reference: YOLOX's own demo (demo/ONNXRuntime): preproc, demo_postprocess, multiclass_nms.
        H = W = 416
        r = min(H / BUS_BGR.shape[0], W / BUS_BGR.shape[1])
        pad = np.full((H, W, 3), 114, np.uint8)
        rs = cv2.resize(BUS_BGR, (int(BUS_BGR.shape[1] * r), int(BUS_BGR.shape[0] * r)), interpolation=cv2.INTER_LINEAR)
        pad[: rs.shape[0], : rs.shape[1]] = rs
        o = run_onnx(OUT / f"yolox-{name}-416.onnx", np.ascontiguousarray(pad.transpose(2, 0, 1), np.float32)[None])
        grids, strides = [], []
        for st in (8, 16, 32):
            xv, yv = np.meshgrid(np.arange(W // st), np.arange(H // st))
            g = np.stack((xv, yv), 2).reshape(-1, 2)
            grids.append(g)
            strides.append(np.full((g.shape[0], 1), st))
        g, st = np.concatenate(grids), np.concatenate(strides)
        o[:, :2] = (o[:, :2] + g) * st
        o[:, 2:4] = np.exp(o[:, 2:4]) * st
        b = o[:, :4]
        xyxy = np.stack([b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2, b[:, 0] + b[:, 2] / 2, b[:, 1] + b[:, 3] / 2], 1) / r
        reference[f"yolox-{name}-416"] = dets(multiclass_nms(xyxy, o[:, 4:5] * o[:, 5:], 0.45))


NANODET_URL = "https://github.com/RangiLyu/nanodet/releases/download/v1.0.0-alpha-1/nanodet-plus-{}_{}.onnx"


@step("NanoDet-Plus")
def nanodet():
    import onnx

    for name, key, label in (("m", "m", "NanoDet-Plus"), ("m-1.5x", "m15", "NanoDet-Plus 1.5x")):
        for size in (416, 320):
            src = fetch(NANODET_URL.format(name, size))
            # The file lists its weights as graph inputs too, which stops ONNX Runtime from folding
            # them (about a third slower); drop them from the inputs.
            m = onnx.load(str(src))
            weights = {i.name for i in m.graph.initializer}
            keep = [i for i in m.graph.input if i.name not in weights]
            del m.graph.input[:]
            m.graph.input.extend(keep)
            onnx.save(m, str(src))
            add(f"nanodet-{key}-{size}", src, "nanodet", size, label, "Apache-2.0")
        # Reference: NanoDet's pipeline for these configs (keep_ratio False, BGR mean/std,
        # GFL heads with reg_max 7 over strides 8, 16, 32, 64, NMS 0.6).
        H = W = 416
        x = cv2.resize(BUS_BGR, (W, H), interpolation=cv2.INTER_LINEAR).astype(np.float32)
        x = (x - np.array([103.53, 116.28, 123.675], np.float32)) / np.array([57.375, 57.12, 58.395], np.float32)
        o = run_onnx(OUT / f"nanodet-{key}-416.onnx", np.ascontiguousarray(x.transpose(2, 0, 1))[None])
        pri = []
        for st in (8, 16, 32, 64):
            h, w = -(-H // st), -(-W // st)
            yy, xx = np.meshgrid(np.arange(h) * st, np.arange(w) * st, indexing="ij")
            pri.append(np.stack([xx.ravel(), yy.ravel(), np.full(h * w, st)], 1))
        pri = np.concatenate(pri).astype(np.float32)
        cls, reg = o[:, :80], o[:, 80:].reshape(-1, 4, 8)
        e = np.exp(reg - reg.max(-1, keepdims=True))
        d = (e / e.sum(-1, keepdims=True) * np.arange(8)).sum(-1) * pri[:, 2:3]
        b = np.stack([pri[:, 0] - d[:, 0], pri[:, 1] - d[:, 1], pri[:, 0] + d[:, 2], pri[:, 1] + d[:, 3]], 1)
        b = np.clip(b, 0, [W, H, W, H]) * np.array([BUS_BGR.shape[1] / W, BUS_BGR.shape[0] / H] * 2)
        reference[f"nanodet-{key}-416"] = dets(multiclass_nms(b, cls, 0.6))


# Lock In's own detector (camera plan, step 4), trained by .github/workflows/camera-train.yml and
# published to a pre-release of this repository with its test against NanoDet-Plus. Taken up only
# once that test says it's better.
LOCKIN_TAG = "camera-models-lockin-1"
LOCKIN_CLASSES = ["person", "cell phone", "tablet", "cup"]


def lockin_fetch(name: str) -> Path | None:
    dst = TMP / "lockin"
    dst.mkdir(exist_ok=True)
    r = subprocess.run(["gh", "release", "download", LOCKIN_TAG, "-p", name, "-D", str(dst), "--clobber", "--repo", os.environ.get("GITHUB_REPOSITORY", "Aztr1xX/lock-in")], capture_output=True, text=True)
    return dst / name if r.returncode == 0 else None


@step("Lock In detector")
def lockin():
    report = lockin_fetch("evaluation.md")
    if report is None:
        print("  not trained yet; skipped")
        return
    numbers = lockin_fetch("evaluation.json")
    test = json.loads(numbers.read_text()) if numbers else {}
    if "NOT better" in report.read_text() or not test.get("better"):
        print("  trained, but its test says it isn't better than NanoDet-Plus; skipped")
        return
    # Its scores aren't the COCO model's: the test found the phone score that matches 0.4 there.
    phone_score = float(test["phone_score"])
    print(f"  phone at a score of {phone_score:.2f}")
    for size in (416, 320):
        src = lockin_fetch(f"lockin-det-{size}.onnx")
        assert src is not None, f"lockin-det-{size}.onnx is missing from {LOCKIN_TAG}"
        add(f"lockin-det-{size}", src, "nanodet", size, "Lock In detector", "Apache-2.0", classes=LOCKIN_CLASSES, phone_score=phone_score)
    # Reference: the same NanoDet-Plus pipeline as above, with 4 classes.
    H = W = 416
    x = cv2.resize(BUS_BGR, (W, H), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    x = (x - np.array([103.53, 116.28, 123.675], np.float32)) / np.array([57.375, 57.12, 58.395], np.float32)
    o = run_onnx(OUT / "lockin-det-416.onnx", np.ascontiguousarray(x.transpose(2, 0, 1))[None])
    pri = []
    for st in (8, 16, 32, 64):
        h, w = -(-H // st), -(-W // st)
        yy, xx = np.meshgrid(np.arange(h) * st, np.arange(w) * st, indexing="ij")
        pri.append(np.stack([xx.ravel(), yy.ravel(), np.full(h * w, st)], 1))
    pri = np.concatenate(pri).astype(np.float32)
    nc = len(LOCKIN_CLASSES)
    cls, reg = o[:, :nc], o[:, nc:].reshape(-1, 4, 8)
    e = np.exp(reg - reg.max(-1, keepdims=True))
    d = (e / e.sum(-1, keepdims=True) * np.arange(8)).sum(-1) * pri[:, 2:3]
    b = np.stack([pri[:, 0] - d[:, 0], pri[:, 1] - d[:, 1], pri[:, 0] + d[:, 2], pri[:, 1] + d[:, 3]], 1)
    b = np.clip(b, 0, [W, H, W, H]) * np.array([BUS_BGR.shape[1] / W, BUS_BGR.shape[0] / H] * 2)
    rows = []
    for c in range(nc):
        m = cls[:, c] > 0.3
        if m.any():
            bb, ss = b[m], cls[m, c]
            rows += [(LOCKIN_CLASSES[c], ss[k], bb[k]) for k in nms(bb, ss, 0.6)]
    reference["lockin-det-416"] = dets(rows)


@step("RTMPose-s")
def rtmpose():
    url = (
        "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/"
        "rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip"
    )
    z = TMP / "rtmpose.zip"
    urllib.request.urlretrieve(url, z)
    with zipfile.ZipFile(z) as f:
        name = next(n for n in f.namelist() if n.endswith("end2end.onnx"))
        f.extract(name, TMP)
    add("rtmpose-s", TMP / name, "rtmpose", (192, 256), "RTMPose-s", "Apache-2.0")
    dst = OUT / "rtmpose-s.onnx"

    # Reference pose for the biggest person RF-DETR found, through rtmlib's own pre/post-processing.
    people = [d for d in reference.get("rfdetr-n-384", []) if d["cls"] == "person"]
    if not people:
        return
    box = max(people, key=lambda d: (d["box"][2] - d["box"][0]) * (d["box"][3] - d["box"][1]))["box"]
    from rtmlib import RTMPose

    pose = RTMPose(onnx_model=str(dst), model_input_size=(192, 256), backend="onnxruntime", device="cpu")
    kpts, scores = pose(np.asarray(BUS), bboxes=[box])
    reference["rtmpose-s"] = [
        dict(box=box, keypoints=[[round(float(x), 1), round(float(y), 1), round(float(s), 3)] for (x, y), s in zip(kpts[0], scores[0])])
    ]


# Every model must open and run in ONNX Runtime on the CPU, the way the app will use it.

for m in models:
    try:
        sess = ort.InferenceSession(str(OUT / m["file"]), providers=["CPUExecutionProvider"])
        inp = sess.get_inputs()[0]
        outs = sess.run(None, {inp.name: np.zeros((1, 3, m["height"], m["width"]), np.float32)})
        m["outputs"] = [[o.name, list(v.shape)] for o, v in zip(sess.get_outputs(), outs)]
        print(f"  runs: {m['id']} -> {m['outputs']}")
    except Exception as e:
        print(f"  DOES NOT RUN: {m['id']}: {e}")
        problems.append(f"{m['id']} doesn't run in ONNX Runtime")

# A full check is the whole frame, a closer look at the hands, and the pose model on the person box.
checks = [
    dict(name="RF-DETR Nano", frame="rfdetr-n-384", hands="rfdetr-n-384", pose="rtmpose-s"),
    dict(name="RF-DETR Nano, 320 px hands", frame="rfdetr-n-384", hands="rfdetr-n-320", pose="rtmpose-s"),
    dict(name="RF-DETR Nano, 8-bit", frame="rfdetr-n-384-int8", hands="rfdetr-n-384-int8", pose="rtmpose-s"),
    dict(name="D-FINE Nano", frame="dfine-n-416", hands="dfine-n-320", pose="rtmpose-s"),
    dict(name="YOLO26n", frame="yolo26n-416", hands="yolo26n-320", pose="rtmpose-s"),
    dict(name="YOLOX Nano", frame="yolox-nano-416", hands="yolox-nano-416", pose="rtmpose-s"),
    dict(name="YOLOX Tiny", frame="yolox-tiny-416", hands="yolox-tiny-416", pose="rtmpose-s"),
    dict(name="NanoDet-Plus", frame="nanodet-m-416", hands="nanodet-m-320", pose="rtmpose-s"),
    dict(name="NanoDet-Plus 1.5x", frame="nanodet-m15-416", hands="nanodet-m15-320", pose="rtmpose-s"),
    dict(name="Lock In detector", frame="lockin-det-416", hands="lockin-det-320", pose="rtmpose-s"),
]
have = {m["id"] for m in models}
checks = [c for c in checks if {c["frame"], c["hands"], c["pose"]} <= have]

(OUT / "manifest.json").write_text(json.dumps(dict(version=1, models=models, checks=checks, coco80=COCO80), indent=2))
(OUT / "reference.json").write_text(json.dumps(reference, indent=2))
print(json.dumps(dict(models=[m["id"] for m in models], checks=[c["name"] for c in checks], problems=problems), indent=2))
if problems:
    sys.exit(f"Some exports failed: {', '.join(problems)}")

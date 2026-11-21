"""Compares Lock In's detector with the NanoDet-Plus COCO model it started from, on held-out
pictures, judged the way the app judges: a phone counts at a score of 0.4 or more.

  * Phones caught: pictures with a phone where the phone was found (box overlapping the real one).
  * Tablets called phones: tablet pictures, no phone, where a phone was reported.
  * Desks called phones: laptop, book or desk pictures with no phone, where a phone was reported.
  * Other false phones: cup and bottle pictures with no phone, where a phone was reported.
  * Drinks found: pictures with a cup, mug or bottle where a drink was found.

Each picture is tried twice: as it is, and as a webcam-style copy (dim, noisy, soft or smeared),
which is closer to what a laptop camera sees.

Writes a table (Markdown) and the numbers (JSON). Exits non-zero if the new detector isn't better
at phones without more false alarms, so it never ships by accident.

    python evaluate.py --data data --new out/lockin-det-416.onnx --base nanodet-plus-m_416.onnx --out report
"""

import argparse
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from data import webcam  # noqa: E402

MEAN = np.array([103.53, 116.28, 123.675], np.float32)
STD = np.array([57.375, 57.12, 58.395], np.float32)
THRESH = 0.4
# Which output classes mean what. COCO order: person 0, bottle 39, wine glass 40, cup 41, cell phone 67.
NEW = {"phone": [1], "drink": [3]}
BASE = {"phone": [67], "drink": [39, 40, 41]}


def priors(size):
    out = []
    for st in (8, 16, 32, 64):
        n = -(-size // st)
        yy, xx = np.meshgrid(np.arange(n) * st, np.arange(n) * st, indexing="ij")
        out.append(np.stack([xx.ravel(), yy.ravel(), np.full(n * n, st)], 1))
    return np.concatenate(out).astype(np.float32)


class Detector:
    """The app's pipeline (vision.rs): stretch to a square, BGR mean/std, GFL decode."""

    def __init__(self, path, size=416):
        o = ort.SessionOptions()
        o.log_severity_level = 3
        self.s = ort.InferenceSession(str(path), o, providers=["CPUExecutionProvider"])
        self.size = size
        self.pri = priors(size)

    def __call__(self, bgr):
        h, w = bgr.shape[:2]
        x = (cv2.resize(bgr, (self.size, self.size), interpolation=cv2.INTER_LINEAR).astype(np.float32) - MEAN) / STD
        o = self.s.run(None, {self.s.get_inputs()[0].name: np.ascontiguousarray(x.transpose(2, 0, 1))[None]})[0][0]
        nc = o.shape[1] - 32
        cls, reg = o[:, :nc], o[:, nc:].reshape(-1, 4, 8)
        e = np.exp(reg - reg.max(-1, keepdims=True))
        d = (e / e.sum(-1, keepdims=True) * np.arange(8)).sum(-1) * self.pri[:, 2:3]
        p = self.pri
        b = np.stack([p[:, 0] - d[:, 0], p[:, 1] - d[:, 1], p[:, 0] + d[:, 2], p[:, 1] + d[:, 3]], 1)
        b = np.clip(b, 0, self.size) * np.array([w / self.size, h / self.size] * 2, np.float32)
        return b, cls


def iou(a, b):
    x1, y1 = np.maximum(a[:, None, 0], b[None, :, 0]), np.maximum(a[:, None, 1], b[None, :, 1])
    x2, y2 = np.minimum(a[:, None, 2], b[None, :, 2]), np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area = lambda r: (r[:, 2] - r[:, 0]) * (r[:, 3] - r[:, 1])
    return inter / (area(a)[:, None] + area(b)[None, :] - inter + 1e-9)


def found(boxes, cls, ids, truth=None):
    """Whether any box of these classes scores THRESH or more (and overlaps a true box, if given)."""
    score = cls[:, ids].max(1)
    keep = score >= THRESH
    if not keep.any():
        return False
    if truth is None or not len(truth):
        return True
    return bool((iou(boxes[keep], truth) >= 0.3).any())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    data, out = Path(a.data), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    test = json.loads((data / "test.json").read_text())
    info = json.loads((data / "test-info.json").read_text())
    boxes_of = {}
    for ann in test["annotations"]:
        x, y, w, h = ann["bbox"]
        boxes_of.setdefault(ann["image_id"], []).append((ann["category_id"], [x, y, x + w, y + h]))
    models = {"Lock In detector": (Detector(a.new), NEW), "NanoDet-Plus (COCO)": (Detector(a.base), BASE)}
    keys = ("phones", "tablets", "desks", "other", "drinks")
    counts = {(m, v): {k: [0, 0] for k in keys} for m in models for v in ("plain", "webcam")}
    rng = random.Random(11)
    for img in test["images"]:
        meta = info.get(img["file_name"])
        if meta is None:
            continue
        rgb = Image.open(data / "images" / img["file_name"]).convert("RGB")
        views = {"plain": rgb, "webcam": webcam(rgb, rng)}
        anns = boxes_of.get(img["id"], [])
        phones = np.array([b for c, b in anns if c == 2], np.float32).reshape(-1, 4)
        drinks = np.array([b for c, b in anns if c == 4], np.float32).reshape(-1, 4)
        for (name, view), c in counts.items():
            det, ids = models[name]
            b, cls = det(cv2.cvtColor(np.asarray(views[view]), cv2.COLOR_RGB2BGR))
            if meta["phone"]:
                c["phones"][1] += 1
                c["phones"][0] += found(b, cls, ids["phone"], phones)
            else:
                said_phone = found(b, cls, ids["phone"])
                key = "tablets" if meta["tablet"] else "desks" if meta["desk"] else "other"
                c[key][1] += 1
                c[key][0] += said_phone
            if len(drinks):
                c["drinks"][1] += 1
                c["drinks"][0] += found(b, cls, ids["drink"], drinks)
    rate = lambda hit, n: hit / n if n else None
    res = {f"{m} ({v})": {k: {"hits": h, "of": n, "rate": rate(h, n)} for k, (h, n) in c.items()} for (m, v), c in counts.items()}
    (out / "evaluation.json").write_text(json.dumps(res, indent=2))
    label = {"phones": "Phones caught", "tablets": "Tablets called phones", "desks": "Desks called phones", "other": "Cups and bottles called phones", "drinks": "Drinks found"}
    pct = lambda r: "n/a" if r["rate"] is None else f"{r['rate'] * 100:.0f}% ({r['hits']} of {r['of']})"
    cols = list(res)
    lines = ["| | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
    for k in label:
        lines.append(f"| {label[k]} | " + " | ".join(pct(res[c][k]) for c in cols) + " |")
    table = "\n".join(lines)
    ok = True
    for v in ("plain", "webcam"):
        new, base = res[f"Lock In detector ({v})"], res[f"NanoDet-Plus (COCO) ({v})"]
        ok &= (new["phones"]["rate"] or 0) > (base["phones"]["rate"] or 0)
        ok &= all((new[k]["rate"] or 0) <= (base[k]["rate"] or 0) + 0.01 for k in ("tablets", "desks", "other"))
    verdict = "Better than the COCO model at phones, with no more false alarms." if ok else "NOT better than the COCO model, so it won't ship."
    (out / "evaluation.md").write_text(f"Held-out test pictures, phone at a score of {THRESH} or more.\n\n{table}\n\n{verdict}\n")
    print(table, verdict, sep="\n", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

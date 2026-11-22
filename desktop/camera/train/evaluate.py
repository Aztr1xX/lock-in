"""Compares Lock In's detector with the NanoDet-Plus COCO model it started from, on held-out
pictures, judged the way the app judges.

  * Phones caught: pictures with a phone where the phone was found (box overlapping the real one).
  * Tablets called phones: tablet pictures, no phone, where a phone was reported.
  * Desks called phones: laptop, book or desk pictures with no phone, where a phone was reported.
  * Other false phones: cup and bottle pictures with no phone, where a phone was reported.
  * Drinks found: pictures with a cup, mug or bottle where a drink was found (score 0.4).

Each picture is tried twice: as it is, and as a webcam-style copy (dim, noisy, soft or smeared),
which is closer to what a laptop camera sees.

The app counts a COCO phone at a score of 0.4. Two detectors' scores don't mean the same thing, so
each other detector gets its own phone score: the lowest at which it raises no more false alarms
than the COCO model at 0.4, on desks, tablets and other pictures, plain and webcam-style. It's
better only if, at that score, it also catches at least as many phones in both. The app then uses
that score for it (written to evaluation.json as "phone_score").

Writes a table (Markdown) and the numbers (JSON). Exits non-zero if the new detector isn't better,
so it never ships by accident.

    python evaluate.py --data data --new out/lockin-det-416.onnx --base nanodet-plus-m_416.onnx --out report [--prev old.onnx]
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


def best_phone(boxes, cls, ids, truth=None):
    """The highest phone score (only boxes overlapping a true phone, if given)."""
    score = cls[:, ids].max(1)
    if truth is not None and len(truth):
        score = score[(iou(boxes, truth) >= 0.3).any(1)]
    return float(score.max()) if len(score) else 0.0


def found(boxes, cls, ids, truth):
    """Whether a box of these classes scores THRESH or more and overlaps a true box."""
    keep = cls[:, ids].max(1) >= THRESH
    return bool(keep.any() and (iou(boxes[keep], truth) >= 0.3).any())


KINDS = ("phones", "tablets", "desks", "other")
FALSE = ("tablets", "desks", "other")
SLACK = 0.005  # half a percentage point, about the noise of a few hundred pictures


def rates(scores, t):
    """Share of each kind of picture with a phone at score t or more."""
    return {k: (sum(s >= t for s in v) / len(v) if v else None) for k, v in scores.items()}


def calibrate(new, base):
    """The lowest phone score at which `new` raises no more false alarms than `base` at THRESH."""
    limit = {v: rates(base[v], THRESH) for v in base}
    for t in np.arange(0.30, 0.96, 0.01):
        t = round(float(t), 2)
        if all((rates(new[v], t)[k] or 0) <= (limit[v][k] or 0) + SLACK for v in new for k in FALSE):
            return t
    return 0.95


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--prev", help="an earlier Lock In detector, to show how far this one moved")
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
    NEW_NAME, BASE_NAME, PREV_NAME = "Lock In detector", "NanoDet-Plus (COCO)", "Earlier Lock In detector"
    models = {NEW_NAME: (Detector(a.new), NEW), BASE_NAME: (Detector(a.base), BASE)}
    if a.prev:
        models[PREV_NAME] = (Detector(a.prev), NEW)
    views = ("plain", "webcam")
    scores = {m: {v: {k: [] for k in KINDS} for v in views} for m in models}
    drinks = {m: {v: [0, 0] for v in views} for m in models}
    rng = random.Random(11)
    for img in test["images"]:
        meta = info.get(img["file_name"])
        if meta is None:
            continue
        rgb = Image.open(data / "images" / img["file_name"]).convert("RGB")
        pics = {"plain": rgb, "webcam": webcam(rgb, rng)}
        anns = boxes_of.get(img["id"], [])
        phones = np.array([b for c, b in anns if c == 2], np.float32).reshape(-1, 4)
        cups = np.array([b for c, b in anns if c == 4], np.float32).reshape(-1, 4)
        kind = "phones" if meta["phone"] else "tablets" if meta["tablet"] else "desks" if meta["desk"] else "other"
        for m, (det, ids) in models.items():
            for v in views:
                b, cls = det(cv2.cvtColor(np.asarray(pics[v]), cv2.COLOR_RGB2BGR))
                if kind == "phones" and not len(phones):
                    continue
                scores[m][v][kind].append(best_phone(b, cls, ids["phone"], phones if kind == "phones" else None))
                if len(cups):
                    drinks[m][v][1] += 1
                    drinks[m][v][0] += found(b, cls, ids["drink"], cups)
    at = {BASE_NAME: THRESH}
    for m in models:
        if m != BASE_NAME:
            at[m] = calibrate(scores[m], scores[BASE_NAME])
    res = {}
    for m in models:
        for v in views:
            r = {}
            for k, vals in scores[m][v].items():
                hits = sum(s >= at[m] for s in vals)
                r[k] = {"hits": hits, "of": len(vals), "rate": hits / len(vals) if vals else None}
            h, n = drinks[m][v]
            r["drinks"] = {"hits": h, "of": n, "rate": h / n if n else None}
            res[f"{m} ({v})"] = r
    new_ok = all((res[f"{NEW_NAME} ({v})"]["phones"]["rate"] or 0) >= (res[f"{BASE_NAME} ({v})"]["phones"]["rate"] or 0) for v in views)
    new_ok &= sum((res[f"{NEW_NAME} ({v})"]["phones"]["rate"] or 0) - (res[f"{BASE_NAME} ({v})"]["phones"]["rate"] or 0) for v in views) > 0
    new_ok &= at[NEW_NAME] < 0.95
    # How many phones it catches at the COCO model's own 0.4, for comparison.
    loose = {v: rates(scores[NEW_NAME][v], THRESH) for v in views}
    (out / "evaluation.json").write_text(json.dumps({"phone_score": at[NEW_NAME], "better": new_ok, "phone_scores": at, "results": res, "new_at_0.4": loose}, indent=2))
    label = {"phones": "Phones caught", "tablets": "Tablets called phones", "desks": "Desks called phones", "other": "Cups and bottles called phones", "drinks": "Drinks found"}
    pct = lambda r: "n/a" if r["rate"] is None else f"{r['rate'] * 100:.0f}% ({r['hits']} of {r['of']})"
    cols = list(res)
    lines = ["| | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
    lines.append("| Phone at a score of | " + " | ".join(f"{at[c.rsplit(' (', 1)[0]]:.2f}" for c in cols) + " |")
    for k in label:
        lines.append(f"| {label[k]} | " + " | ".join(pct(res[c][k]) for c in cols) + " |")
    table = "\n".join(lines)
    l04 = ", ".join(f"{v}: phones {loose[v]['phones'] * 100:.0f}%, desks {loose[v]['desks'] * 100:.0f}%" for v in views)
    verdict = (
        f"Better than the COCO model at phones, with no more false alarms, at a phone score of {at[NEW_NAME]:.2f}."
        if new_ok
        else "NOT better than the COCO model, so it won't ship."
    )
    (out / "evaluation.md").write_text(f"Held-out test pictures. Each detector at the phone score where it raises no more false alarms than the COCO model at {THRESH}.\n\n{table}\n\nThe Lock In detector at {THRESH} instead: {l04}.\n\n{verdict}\n")
    print(table, l04, verdict, sep="\n", flush=True)
    sys.exit(0 if new_ok else 1)


if __name__ == "__main__":
    main()

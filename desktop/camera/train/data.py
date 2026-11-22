"""Builds the training and test pictures for Lock In's own detector (camera plan, step 4).

Four classes: person, phone, tablet, drink. Sources, all public:
  * Open Images V7 boxes (annotations CC BY 4.0, images CC BY 2.0): mobile phones, tablet
    computers, coffee cups, mugs and bottles, with the people in the same pictures.
  * COCO 2017 (annotations CC BY 4.0), when reachable: every picture with a cell phone, some with
    cups and bottles, and some with only people, so the detector keeps finding people well.
  * Look-alikes with no phone, from both: laptops, keyboards, books, remotes, calculators, screens.
    Without them the detector learns "a flat dark rectangle is a phone" and calls keyboards and
    book covers phones.

Every picture is shrunk to at most 640 px and saved as JPEG. About 30% of the training
pictures also get a second, webcam-style copy: dim, noisy, blurred like NVIDIA Broadcast's
background blur, or smeared by motion.

Out (COCO format, which NanoDet trains from):
  data/images/*.jpg
  data/train.json     training pictures
  data/val.json       a small slice for NanoDet's own progress check
  data/test.json      held-out pictures for evaluate.py: phones, tablets, and desks without phones

    python data.py data [--small]   (--small: a few hundred pictures, for a quick local check)
"""

import argparse
import csv
import hashlib
import io
import json
import random
import sys
import urllib.request
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

CLASSES = ["person", "phone", "tablet", "drink"]

OI = "https://storage.googleapis.com/openimages"
OI_IMAGES = "https://open-images-dataset.s3.amazonaws.com/{split}/{id}.jpg"
OI_BOXES = {
    "train": f"{OI}/v6/oidv6-train-annotations-bbox.csv",
    "validation": f"{OI}/v5/validation-annotations-bbox.csv",
    "test": f"{OI}/v5/test-annotations-bbox.csv",
}
# Open Images label -> our class. People are labelled as Person, Man, Woman, Boy or Girl.
OI_LABELS = {
    "/m/050k8": "phone",  # Mobile phone
    "/m/0bh9flk": "tablet",  # Tablet computer
    "/m/02p5f1q": "drink",  # Coffee cup
    "/m/02jvh9": "drink",  # Mug
    "/m/04dr76w": "drink",  # Bottle
    "/m/01g317": "person",
    "/m/04yx4": "person",
    "/m/03bt1vf": "person",
    "/m/01bl7v": "person",
    "/m/05r655": "person",
}
# Desks without phones, for counting false alarms in the test set.
OI_DESK = {"/m/01c648", "/m/0bt_c3", "/m/01y9k5"}  # Laptop, Book, Desk
# Phone look-alikes, trained on as pictures with no phone (only their people and drinks boxed).
OI_LOOKALIKE = OI_DESK | {
    "/m/01m2v",  # Computer keyboard
    "/m/024d2",  # Calculator
    "/m/02522",  # Computer monitor
    "/m/020lf",  # Computer mouse
    "/m/0qjjc",  # Remote control
    "/m/07c52",  # Television
    "/m/06z37_",  # Picture frame
    "/m/03__z0",  # Bookcase
}
# A picture with one of these may hold a phone boxed only as something else, so it's never a look-alike.
OI_MAYBE_PHONE = {"/m/07cx4", "/m/0mcx2"}  # Telephone, Ipod
LOOKALIKES = 3000  # Open Images look-alike pictures; COCO adds up to 2500 more

COCO_ANN = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
COCO_IMAGES = "http://images.cocodataset.org/train2017/{}"
COCO_LABELS = {1: "person", 77: "phone", 41: "drink", 44: "drink", 46: "drink"}  # person, cell phone, bottle, wine glass, cup
COCO_LOOKALIKE = {72, 73, 74, 75, 76, 84}  # tv, laptop, mouse, remote, keyboard, book

MAX_SIDE = 640
CAM_SHARE = 0.3  # share of training pictures that also get a webcam-style copy


def log(*a):
    print(*a, flush=True)


def held_out(image_id: str) -> bool:
    """One in twelve Open Images training pictures is kept back for testing, chosen by id."""
    return int(hashlib.sha1(image_id.encode()).hexdigest(), 16) % 12 == 0


def read_boxes(split: str, wanted: set):
    """Open Images boxes of the wanted labels, per picture. Streams the file (2.3 GB for train)."""
    out = defaultdict(list)
    with urllib.request.urlopen(OI_BOXES[split]) as r:
        rows = csv.reader(io.TextIOWrapper(r, encoding="utf-8"))
        head = next(rows)
        col = {k: i for i, k in enumerate(head)}
        for row in rows:
            label = row[col["LabelName"]]
            if label in wanted:
                out[row[col["ImageID"]]].append(
                    (label, *(float(row[col[k]]) for k in ("XMin", "YMin", "XMax", "YMax")), row[col["IsGroupOf"]] == "1", row[col["IsDepiction"]] == "1")
                )
    return out


def webcam(img: Image.Image, rng: random.Random) -> Image.Image:
    """A webcam-style copy: dim, noisy, background-blurred, motion-smeared, or a mix."""
    kind = rng.choice(["dim", "noise", "soft", "motion", "dim+noise"])
    a = np.asarray(img).astype(np.float32)
    if "dim" in kind:
        a = a * rng.uniform(0.2, 0.5) + rng.uniform(0, 12)
    if "noise" in kind:
        a = a + np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(6, 16), a.shape)
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if kind == "soft":
        out = out.filter(ImageFilter.GaussianBlur(rng.uniform(1.0, 2.2)))
    if kind == "motion":
        k = rng.choice([5, 7, 9])
        m = np.zeros((k, k), np.float32)
        m[k // 2, :] = 1 / k
        if rng.random() < 0.5:
            m = m.T
        out = Image.fromarray(cv2.filter2D(np.asarray(out), -1, m))
    return out


def fetch_image(url: str):
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                img = Image.open(io.BytesIO(r.read())).convert("RGB")
            if max(img.size) > MAX_SIDE:
                img.thumbnail((MAX_SIDE, MAX_SIDE), Image.BILINEAR)
            return img
        except Exception:
            continue
    return None


def fetch_all(pool: ThreadPoolExecutor, urls, chunk=400):
    """The pictures at these urls, in order, downloaded a chunk at a time: pool.map on its own
    downloads far faster than they're saved, and holds every waiting picture in memory."""
    for i in range(0, len(urls), chunk):
        yield from pool.map(fetch_image, urls[i : i + chunk])


class Writer:
    """Collects pictures and boxes into COCO-format sets."""

    def __init__(self, root: Path):
        self.root = root
        (root / "images").mkdir(parents=True, exist_ok=True)
        self.sets = {k: {"images": [], "annotations": [], "categories": [{"id": i + 1, "name": c} for i, c in enumerate(CLASSES)]} for k in ("train", "val", "test")}
        self.next_img = 1
        self.next_box = 1
        self.extra = {}  # test picture id -> what it holds

    def add(self, split: str, name: str, img: Image.Image, boxes, info=None):
        """boxes: (class, x1, y1, x2, y2) in 0..1."""
        img.save(self.root / "images" / name, quality=90)
        w, h = img.size
        iid = self.next_img
        self.next_img += 1
        self.sets[split]["images"].append({"id": iid, "file_name": name, "width": w, "height": h})
        for c, x1, y1, x2, y2 in boxes:
            bw, bh = (x2 - x1) * w, (y2 - y1) * h
            if bw < 2 or bh < 2:
                continue
            self.sets[split]["annotations"].append(
                {"id": self.next_box, "image_id": iid, "category_id": CLASSES.index(c) + 1, "bbox": [x1 * w, y1 * h, bw, bh], "area": bw * bh, "iscrowd": 0}
            )
            self.next_box += 1
        if info:
            self.extra[name] = info

    def save(self):
        for k, v in self.sets.items():
            (self.root / f"{k}.json").write_text(json.dumps(v))
            n = defaultdict(int)
            for a in v["annotations"]:
                n[CLASSES[a["category_id"] - 1]] += 1
            log(f"{k}: {len(v['images'])} pictures, boxes {dict(n)}")
        (self.root / "test-info.json").write_text(json.dumps(self.extra))


def usable(boxes):
    """Our boxes for one Open Images picture, or None if it can't be used: any drawing, or a
    phone, tablet or drink marked only as a group ("several phones"), which would teach the wrong box."""
    if any(depiction for *_, depiction in boxes):
        return None
    out = []
    for label, x1, y1, x2, y2, group, _ in boxes:
        c = OI_LABELS.get(label)
        if c is None:
            continue
        if group and c != "person":
            return None
        out.append((c, x1, y1, x2, y2))
    return out


def open_images(w: Writer, small: bool, rng: random.Random, pool: ThreadPoolExecutor):
    caps = {"phone": 60, "tablet": 30, "drink": 60} if small else {"phone": 100000, "tablet": 100000, "drink": 2500}
    wanted = set(OI_LABELS) | OI_DESK
    jobs = []  # (split, set, id, boxes, info)
    lookalikes = []  # training pictures with phone look-alikes and no phone
    for split in (["validation"] if small else ["train", "validation", "test"]):
        log(f"Reading Open Images {split} boxes...")
        everything = read_boxes(split, wanted | OI_LOOKALIKE | OI_MAYBE_PHONE)
        # The test pictures are picked from exactly the same list as before look-alikes were added,
        # so a newer detector is tested on the same pictures.
        per = {i: [b for b in rows if b[0] in wanted] for i, rows in everything.items()}
        per = {i: rows for i, rows in per.items() if rows}
        ids = sorted(per)
        rng.shuffle(ids)
        taken = defaultdict(int)
        desks = 0
        for iid in ids:
            boxes = usable(per[iid])
            if boxes is None:
                continue
            has = {c for c, *_ in boxes}
            labels = {b[0] for b in per[iid]}
            test = split != "train" or held_out(iid)
            if small:
                test = held_out(iid) or rng.random() < 0.25
            if "phone" in has or "tablet" in has:
                key = "phone" if "phone" in has else "tablet"
            elif "drink" in has:
                key = "drink"
            elif labels & OI_DESK and test:
                if desks >= (40 if small else 900):
                    continue
                desks += 1
                jobs.append((split, "test", iid, boxes, {"phone": False, "tablet": False, "desk": True}))
                continue
            else:
                continue
            if not test:
                if taken[key] >= caps[key]:
                    continue
                taken[key] += 1
            jobs.append((split, "test" if test else "train", iid, boxes, {"phone": "phone" in has, "tablet": "tablet" in has, "desk": False} if test else None))
        log(f"  {split}: training pictures {dict(taken)}")
        if split == "train" or small:
            # Look-alikes: only training pictures that aren't held back, with no phone or tablet.
            # Only their few usable boxes are kept: the whole train list doesn't fit in memory twice.
            for iid in sorted(everything):
                labels = {b[0] for b in everything[iid]}
                if held_out(iid) or not labels & OI_LOOKALIKE or labels & OI_MAYBE_PHONE:
                    continue
                boxes = usable([b for b in everything[iid] if b[0] in OI_LABELS])
                if boxes is not None and not {"phone", "tablet"} & {c for c, *_ in boxes}:
                    lookalikes.append((split, iid, boxes))
        del everything, per
    random.Random(13).shuffle(lookalikes)
    lookalikes = lookalikes[: 40 if small else LOOKALIKES]
    jobs += [(split, "train", iid, boxes, None) for split, iid, boxes in lookalikes]
    log(f"  look-alikes with no phone: {len(lookalikes)}")
    log(f"Downloading {len(jobs)} Open Images pictures...")
    imgs = fetch_all(pool, [OI_IMAGES.format(split=j[0], id=j[2]) for j in jobs])
    got = 0
    for (split, dest, iid, boxes, info), img in zip(jobs, imgs):
        if img is None:
            continue
        got += 1
        if dest == "train" and rng.random() < 0.08:
            dest = "val"  # a small slice for NanoDet's progress check
        w.add(dest, f"oi-{iid}.jpg", img, boxes, info)
        if dest == "train" and rng.random() < CAM_SHARE:
            w.add("train", f"oi-{iid}-cam.jpg", webcam(img, rng), boxes)
    log(f"  got {got} of {len(jobs)}")


def coco(w: Writer, small: bool, rng: random.Random, pool: ThreadPoolExecutor):
    log("Reading COCO annotations...")
    try:
        with urllib.request.urlopen(COCO_ANN, timeout=60) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
    except Exception as e:
        log(f"  COCO isn't reachable ({e}); training on Open Images only.")
        return
    d = json.loads(z.read("annotations/instances_train2017.json"))
    per = defaultdict(list)
    for a in d["annotations"]:
        if a["category_id"] in COCO_LABELS and not a["iscrowd"]:
            per[a["image_id"]].append(a)
    crowd = {a["image_id"] for a in d["annotations"] if a["iscrowd"] and a["category_id"] in COCO_LABELS}
    alike = {a["image_id"] for a in d["annotations"] if a["category_id"] in COCO_LOOKALIKE}
    imgs = {i["id"]: i for i in d["images"]}
    ids = sorted(set(per) | alike)
    rng.shuffle(ids)
    caps = {"phone": 40, "drink": 20, "person": 20, "look-alike": 20} if small else {"phone": 100000, "drink": 1000, "person": 1000, "look-alike": 2500}
    taken = defaultdict(int)
    jobs = []
    for iid in ids:
        if iid in crowd:
            continue
        has = {COCO_LABELS[a["category_id"]] for a in per[iid]}
        # COCO boxes every phone, so a look-alike picture without a phone box truly has none.
        key = "phone" if "phone" in has else "look-alike" if iid in alike else "drink" if "drink" in has else "person"
        if taken[key] >= caps[key]:
            continue
        taken[key] += 1
        jobs.append(iid)
    log(f"  COCO training pictures {dict(taken)}; downloading...")
    keep = set(jobs)
    per = {i: per[i] for i in keep}
    imgs = {i: imgs[i] for i in keep}
    del d, z  # several GB of annotations, no longer needed while the pictures come in
    pics = fetch_all(pool, [COCO_IMAGES.format(imgs[i]["file_name"]) for i in jobs])
    for iid, img in zip(jobs, pics):
        if img is None:
            continue
        W, H = imgs[iid]["width"], imgs[iid]["height"]
        boxes = [(COCO_LABELS[a["category_id"]], a["bbox"][0] / W, a["bbox"][1] / H, (a["bbox"][0] + a["bbox"][2]) / W, (a["bbox"][1] + a["bbox"][3]) / H) for a in per[iid]]
        dest = "val" if rng.random() < 0.05 else "train"
        w.add(dest, f"coco-{iid}.jpg", img, boxes)
        if dest == "train" and rng.random() < CAM_SHARE:
            w.add("train", f"coco-{iid}-cam.jpg", webcam(img, rng), boxes)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("--small", action="store_true")
    a = p.parse_args()
    rng = random.Random(7)
    w = Writer(Path(a.out))
    with ThreadPoolExecutor(48) as pool:
        open_images(w, a.small, rng, pool)
        coco(w, a.small, rng, pool)
    w.save()
    if not w.sets["train"]["images"]:
        sys.exit("No training pictures")


if __name__ == "__main__":
    main()

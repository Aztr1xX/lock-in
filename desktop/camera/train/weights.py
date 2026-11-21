"""Starts Lock In's detector from NanoDet-Plus's COCO weights (Apache 2.0).

The COCO model scores 80 classes; ours scores 4. Rather than start the new class scores from
nothing, each one starts as copy of the closest COCO class: person from person, phone from cell
phone, tablet from laptop, drink from cup. Everything else (backbone, neck, box regression)
carries over as it is. Saved for CPU, so NanoDet's loader can read it on a machine without a GPU.

    python weights.py nanodet-plus-m_416_checkpoint.ckpt start.ckpt
"""

import sys

import torch

# COCO's 80-class order (as NanoDet uses it): person 0, cup 41, laptop 63, cell phone 67.
FROM_COCO = [0, 67, 63, 41]  # person, phone, tablet, drink
COCO = 80


def main(src, dst):
    ckpt = torch.load(src, map_location="cpu")
    sd = ckpt["state_dict"]
    rows = torch.tensor(FROM_COCO)
    for k, v in list(sd.items()):
        if ".head.gfl_cls." in k and v.shape[0] == COCO + 32:
            # The main head scores classes and box sides in one layer: 80 class rows, then 4 x 8.
            sd[k] = torch.cat([v[rows], v[COCO:]])
        elif ".aux_head.gfl_cls." in k and v.shape[0] == COCO:
            sd[k] = v[rows]
    # NanoDet's loader treats a checkpoint without this key as an old format and converts it.
    torch.save({"state_dict": sd, "pytorch-lightning_version": "1.9.5"}, dst)
    print(f"Saved {dst}: classes from COCO rows {FROM_COCO}")


if __name__ == "__main__":
    main(*sys.argv[1:3])

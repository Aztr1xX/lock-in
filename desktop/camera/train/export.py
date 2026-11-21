"""Exports the trained detector to ONNX at 416 px (the whole picture) and 320 px (the closer look
at your hands), in the same layout as NanoDet-Plus's own release files, so the app reads it the
same way: one row per centre point, 4 class scores (already 0..1), then 4 x 8 box-side bins.

    python export.py --nanodet nanodet-src --run run --out out
"""

import argparse
import sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--nanodet", required=True)
    p.add_argument("--run", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    sys.path.insert(0, a.nanodet)
    import onnx
    import torch
    from nanodet.model.arch import build_model
    from nanodet.util import Logger, cfg, load_config, load_model_weight
    from onnxsim import simplify

    run, out = Path(a.run), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    load_config(cfg, str(run / "config.yml"))
    best = run / "model_best" / "model_best.ckpt"
    src = best if best.exists() else run / "model_last.ckpt"
    model = build_model(cfg.model)
    load_model_weight(model, torch.load(src, map_location="cpu"), Logger(-1, use_tensorboard=False))
    model.eval()
    for size in (416, 320):
        dst = out / f"lockin-det-{size}.onnx"
        torch.onnx.export(model, torch.randn(1, 3, size, size), str(dst), opset_version=11, input_names=["data"], output_names=["output"], do_constant_folding=True)
        m, ok = simplify(onnx.load(str(dst)))
        assert ok, "onnx-simplifier couldn't check the model"
        onnx.save(m, str(dst))
        print(f"{dst}: from {src.name}, output {[d.dim_value for d in m.graph.output[0].type.tensor_type.shape.dim]}", flush=True)


if __name__ == "__main__":
    main()

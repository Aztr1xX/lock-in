"""Trains Lock In's detector: NanoDet-Plus-m at 416 px with four classes (person, phone, tablet,
drink), starting from weights.py's COCO start. Runs on the CPU.

Stops by itself after --hours, keeping the last finished epoch, and carries on from there when run
again with the same --out (GitHub's machines allow 6 hours a run).

    python train.py --nanodet nanodet-src --data data --start start.ckpt --out run [--epochs 12] [--hours 5.2]
"""

import argparse
import os
import sys
from datetime import timedelta
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--nanodet", required=True, help="NanoDet's source folder")
    p.add_argument("--data", required=True)
    p.add_argument("--start", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=int, default=12)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--hours", type=float, default=5.2)
    p.add_argument("--size", type=int, default=416)
    a = p.parse_args()
    sys.path.insert(0, a.nanodet)

    import pytorch_lightning as pl
    import torch
    from nanodet.data.collate import naive_collate
    from nanodet.data.dataset import build_dataset
    from nanodet.evaluator import build_evaluator
    from nanodet.trainer.task import TrainingTask
    from nanodet.util import NanoDetLightningLogger, cfg, load_config, load_model_weight
    from pytorch_lightning.callbacks import Timer, TQDMProgressBar

    class RunTimer(Timer):
        """Lightning's time limit, counted from this run's start. The stock one saves the time used
        so far in the checkpoint and adds it back on resume, so a run carrying on would stop at once."""

        def load_state_dict(self, state_dict):
            pass

    sys.path.insert(0, str(Path(__file__).parent))
    from data import CLASSES

    data, out = Path(a.data).resolve(), Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    load_config(cfg, os.path.join(a.nanodet, "config", "nanodet-plus-m_416.yml"))
    cfg.defrost()
    cfg.save_dir = str(out)
    cfg.class_names = CLASSES
    cfg.model.arch.head.num_classes = len(CLASSES)
    cfg.model.arch.aux_head.num_classes = len(CLASSES)
    # The helper head guides which boxes learn what early on. Starting from trained weights, it
    # only needs the first quarter of the run.
    cfg.model.arch.detach_epoch = max(1, a.epochs // 4)
    cfg.model.arch.backbone.pretrain = False  # the COCO start replaces it anyway, and it would download
    for split, ann in (("train", "train.json"), ("val", "val.json")):
        d = cfg.data[split]
        d.img_path = str(data / "images")
        d.ann_path = str(data / ann)
        d.input_size = [a.size, a.size]
    cfg.device.gpu_ids = -1
    cfg.device.workers_per_gpu = 4
    cfg.device.batchsize_per_gpu = a.batch
    s = cfg.schedule
    s.load_model = str(Path(a.start).resolve())
    s.optimizer.lr = 0.0004  # the COCO run's 0.001 at batch 96, scaled to batch 32 and eased for fine-tuning
    s.warmup.steps = 300
    s.total_epochs = a.epochs
    s.lr_schedule.T_max = a.epochs
    s.lr_schedule.eta_min = 0.00002
    s.val_intervals = 1
    cfg.log.interval = 20
    cfg.freeze()
    (out / "config.yml").write_text(cfg.dump())

    torch.set_num_threads(os.cpu_count() or 4)
    logger = NanoDetLightningLogger(str(out))
    train_set = build_dataset(cfg.data.train, "train")
    val_set = build_dataset(cfg.data.val, "test")
    loader = lambda ds, shuffle: torch.utils.data.DataLoader(
        ds, batch_size=a.batch, shuffle=shuffle, num_workers=4, collate_fn=naive_collate, drop_last=shuffle, persistent_workers=True
    )
    task = TrainingTask(cfg, build_evaluator(cfg.evaluator, val_set))
    last = out / "model_last.ckpt"
    if not last.exists():
        load_model_weight(task.model, torch.load(s.load_model, map_location="cpu"), logger)
        logger.info(f"Starting from {s.load_model}")
    else:
        logger.info(f"Carrying on from {last}")
    trainer = pl.Trainer(
        default_root_dir=str(out),
        max_epochs=a.epochs,
        check_val_every_n_epoch=1,
        accelerator="cpu",
        log_every_n_steps=cfg.log.interval,
        num_sanity_val_steps=0,
        callbacks=[TQDMProgressBar(refresh_rate=0), RunTimer(duration=timedelta(hours=a.hours), interval="step")],
        logger=logger,
        gradient_clip_val=cfg.get("grad_clip", 0.0),
        enable_checkpointing=False,
    )
    train_loader = loader(train_set, True)
    trainer.fit(task, train_loader, loader(val_set, False), ckpt_path=str(last) if last.exists() else None)
    # Counted in steps: a run stopped partway through the last epoch already shows it as reached.
    total = a.epochs * len(train_loader)
    step = trainer.global_step
    done = step >= total
    (out / "status.txt").write_text(f"epochs {step / len(train_loader):.2f} of {a.epochs} (step {step} of {total})\n{'done' if done else 'unfinished'}\n")
    print(f"Trained {step} of {total} steps", flush=True)


if __name__ == "__main__":
    main()

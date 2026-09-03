#!/usr/bin/env python3
"""Build labeled, upscaled composite sheets for manual pixel review of
SILENT_MISMATCH_CANDIDATE crops produced by measure_batching_error.py.

Each sheet stacks CARDS_PER_SHEET crops, each upscaled by SCALE and
preceded by a text label (AC/part/serial, batched-vs-isolated reading) so
a reviewer can look at one sheet image and record a verdict per card
without cross-referencing a separate list.

    python scripts/ocr/build_candidate_review_sheets.py \
        cache/ocr-batching-check-50k-summary.json \
        cache/ocr-batching-check-50k-retry2-summary.json \
        --out-dir cache/ocr-batching-review-50k \
        --manifest-out cache/ocr-batching-review-50k-manifest.json
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SCALE = 8
CARDS_PER_SHEET = 6
LABEL_H = 22
PAD = 6


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('summaries', nargs='+', help='One or more *-summary.json files from measure_batching_error.py')
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--manifest-out', required=True)
    ap.add_argument('--cards-per-sheet', type=int, default=CARDS_PER_SHEET)
    args = ap.parse_args()

    candidates = []
    seen = set()
    for sp in args.summaries:
        data = json.loads(Path(sp).read_text('utf8'))
        for c in data['candidates']:
            if c.get('verdict') != 'SILENT_MISMATCH_CANDIDATE':
                continue
            key = (c['ac'], c['part'], c['serial'])
            if key in seen:
                continue
            seen.add(key)
            candidates.append(c)

    candidates.sort(key=lambda c: (c['ac'], c['part'], c['serial']))
    print(f'{len(candidates)} unique silent-mismatch candidates across {len(args.summaries)} summary file(s).')

    out_dir = Path(args.out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    try:
        font = ImageFont.truetype('cour.ttf', 14)
    except OSError:
        font = ImageFont.load_default()

    manifest = []
    n_sheets = 0
    for i in range(0, len(candidates), args.cards_per_sheet):
        chunk = candidates[i:i + args.cards_per_sheet]
        n_sheets += 1
        rows = []
        max_w = 0
        for c in chunk:
            crop = Image.open(c['crop']).convert('RGB')
            w, h = crop.size
            crop = crop.resize((w * SCALE, h * SCALE), Image.NEAREST)
            max_w = max(max_w, crop.width)
            rows.append((c, crop))

        sheet_w = max_w + PAD * 2
        sheet_h = sum(LABEL_H + r[1].height + PAD for r in rows) + PAD
        sheet = Image.new('RGB', (sheet_w, sheet_h), 'white')
        draw = ImageDraw.Draw(sheet)

        y = PAD
        card_index = []
        for c, crop in rows:
            label = f"AC{c['ac']}/part{c['part']}/serial{c['serial']}  batched={c['batched']}  isolated={c['isolated']}"
            draw.text((PAD, y), label, fill='black', font=font)
            y += LABEL_H
            sheet.paste(crop, (PAD, y))
            card_index.append({'ac': c['ac'], 'part': c['part'], 'serial': c['serial'],
                                'batched': c['batched'], 'isolated': c['isolated'], 'y': y})
            y += crop.height + PAD

        sheet_path = out_dir / f'sheet-{n_sheets}.png'
        sheet.save(sheet_path)
        manifest.append({'sheet': str(sheet_path), 'cards': card_index})

    Path(args.manifest_out).write_text(json.dumps(manifest, indent=2), 'utf8')
    print(f'{n_sheets} sheet(s) written to {out_dir}')
    print(f'Manifest written to {args.manifest_out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

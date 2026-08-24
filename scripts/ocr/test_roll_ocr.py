"""Accuracy harness for the roll OCR, against hand-transcribed ground truth.

Two pages from two states, at two different render resolutions, because the
geometry is measured rather than assumed and that claim needs testing. Failing
this is a hard stop: a wrong EPIC does not degrade the site gracefully, it tells
a real person the wrong answer about their vote.

  python scripts/ocr/test_roll_ocr.py <karnataka.pdf> <meghalaya.pdf>
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from roll_ocr import EPIC_RE, page_images, read_page  # noqa: E402

# AC 24 Bagalkot (Karnataka, S10), part 4, page 5 — 1652x2338
KARNATAKA = """TDB3967932 TDB4895090 LYV1221134 LYV1224666 TDB0917013 TDB0918169
TDB0319038 TDB0918177 TDB3459005 TDB3459054 TDB3544004 TDB3968054 TDB3967940
TDB2009702 TDB0319129 TDB2009710 TDB3544335 TDB3967973 TDB3967981 TDB0919100
TDB2009728 TDB0918391 TDB0917286 TDB3459013 TDB3458973 TDB2009744 TDB2009751
TDB2009769 TDB2009777 TDB2009785""".split()

# AC 41 Songsak (Meghalaya, S15), part 1, page 5 — 1983x2806
MEGHALAYA = """TQK0000661 TQK1034750 TQK1034727 TQK1034735 TQK1083393 DRS0530782
BRJ0527184 DRS0629600 DRS0629428 TQK1054063 TQK1117373 DRS0660878 TQK1036367
TQK1105774 TQK1024421 TQK1039015 TQK1105766 DRS0531020 DRS0530931 TQK1133305
DRS0629444 TQK0050849 TQK0037440 DRS0629451 TQK0000745 TQK1089358 DRS0531004
DRS0531012 TQK1018126 TQK0000687""".split()

CASES = [('Karnataka AC24 part4 p5', KARNATAKA, 61), ('Meghalaya AC41 part1 p5', MEGHALAYA, 61)]


def main(paths):
    failures = 0
    for (label, truth, first_serial), path in zip(CASES, paths):
        pages = list(page_images(path))
        rows = read_page(pages[4])          # page 5 is the first elector page
        print(f'\n=== {label} ===')
        print(f'  cards found: {len(rows)}  (expected {len(truth)})')
        if len(rows) != len(truth):
            failures += 1

        epic_hits = serial_hits = 0
        for i, row in enumerate(rows[:len(truth)]):
            want_epic, want_serial = truth[i], first_serial + i
            epic_ok, serial_ok = row.epic == want_epic, row.serial == want_serial
            epic_hits += epic_ok
            serial_hits += serial_ok
            if not (epic_ok and serial_ok):
                print(f'    serial {want_serial}: got {row.serial}/{row.epic!r} '
                      f'want {want_serial}/{want_epic!r} ok={row.ok}')

        n = len(truth)
        print(f'  EPIC   {epic_hits}/{n} exact  ({epic_hits/n*100:.1f}%)')
        print(f'  serial {serial_hits}/{n} exact  ({serial_hits/n*100:.1f}%)')
        # Rows the pipeline itself flags as unreliable — these are withheld, not
        # published, so they cost coverage rather than correctness.
        flagged = sum(1 for r in rows if not r.ok)
        print(f'  self-flagged unreliable: {flagged}')
        wrong_but_confident = sum(
            1 for i, r in enumerate(rows[:n]) if r.ok and r.epic != truth[i])
        print(f'  WRONG BUT CONFIDENT: {wrong_but_confident}')
        if wrong_but_confident:
            failures += 1
        if epic_hits < n or serial_hits < n:
            failures += 1

    print('\nFAIL' if failures else '\nPASS — both pages read exactly')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

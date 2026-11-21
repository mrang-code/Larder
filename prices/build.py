#!/usr/bin/env python3
"""Builds prices.json (served to every Larder phone) from this week's collected prices.

Inputs, written by the weekly price run:
  prices/raw/<store>.json   {"<basket key>": {"price": 1.75, "loyalty": 1.60 or null, "product": "Tesco ... 2.272L"}}
  prices/raw/which.json     {"month": "November 2026", "url": "...", "basket": {"aldi": 76.77, "tesco": 87.42, ...}}
Prices that a store didn't give this week are carried forward for up to 4 weeks.
Usage: python3 prices/build.py
"""
import json, os, sys, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(ROOT), 'prices.json')
STORES = ['tesco', 'sainsburys', 'asda', 'morrisons', 'aldi', 'lidl', 'ocado', 'waitrose']
KEEP_WEEKS = 4

def load(path, default):
    try:
        with open(path) as f: return json.load(f)
    except (OSError, ValueError): return default

basket = load(os.path.join(ROOT, 'basket.json'), {})
keys = [i['key'] for i in basket.get('items', [])]
today = datetime.date.today().isoformat()
old = load(OUT, {})
problems = []

items = {}
for store in basket.get('stores_direct', []):
    raw = load(os.path.join(ROOT, 'raw', store + '.json'), {})
    got = 0
    for k in keys:
        r = raw.get(k) or {}
        try: p = round(float(r.get('price')) * 100)
        except (TypeError, ValueError): p = 0
        try: l = round(float(r.get('loyalty')) * 100) if r.get('loyalty') not in (None, '', 0) else 0
        except (TypeError, ValueError): l = 0
        if not (10 <= p <= 3000): continue
        if l and not (0.4 * p <= l < p): l = 0
        e = {'p': p, 'prod': str(r.get('product') or '')[:70], 'd': today}
        if l: e['l'] = l
        items.setdefault(k, {})[store] = e
        got += 1
    if got < len(keys) * 0.5: problems.append(f'{store}: only {got} of {len(keys)} prices this week')

# carry forward recent prices a store didn't give this week
cut = (datetime.date.today() - datetime.timedelta(weeks=KEEP_WEEKS)).isoformat()
for k, per in (old.get('items') or {}).items():
    if k not in keys: continue
    for store, e in per.items():
        if store not in items.get(k, {}) and e.get('d', '') >= cut:
            items.setdefault(k, {})[store] = e

# store price levels from Which?'s monthly basket, relative to Tesco
which = load(os.path.join(ROOT, 'raw', 'which.json'), {}) or {}
wb = {s: float(v) for s, v in (which.get('basket') or {}).items() if s in STORES and float(v) > 0}
if 'tesco' in wb and len(wb) >= 5:
    factors = {s: round(v / wb['tesco'], 3) for s, v in wb.items()}
    which_info = {'month': which.get('month', ''), 'url': which.get('url', '')}
else:
    factors = old.get('factors') or {}
    which_info = old.get('which') or {}
    problems.append('which.json missing or incomplete; kept last factors')

out = {'updated': today, 'items': items, 'factors': factors, 'which': which_info,
       'direct': basket.get('stores_direct', []), 'n': len(items)}
with open(OUT, 'w') as f: json.dump(out, f, separators=(',', ':'), sort_keys=True)
print(f'prices.json: {len(items)} items, factors for {len(factors)} stores')
for p in problems: print('WARNING:', p)
sys.exit(1 if len(items) < len(keys) * 0.3 else 0)

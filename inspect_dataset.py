# Quick dataset diagnostics
from pathlib import Path
import argparse, json
from app import FlyDataset

p=argparse.ArgumentParser()
p.add_argument("data",type=Path)
a=p.parse_args()
ds=FlyDataset(a.data)
print(json.dumps(ds.status(),ensure_ascii=False,indent=2))

@echo off
echo FlyBrain SWC Atlas - Quality mode (LOD 64, 4 workers)
echo Progress and ETA will be shown. Safe to Ctrl+C and resume later.
python app.py atlas --data "A:\flybrain" --max-segments 64 --workers 4
pause

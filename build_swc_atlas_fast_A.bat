@echo off
echo FlyBrain SWC Atlas - Fast preview (LOD 32, 4 workers)
python app.py atlas --data "A:\flybrain" --max-segments 32 --workers 4
pause

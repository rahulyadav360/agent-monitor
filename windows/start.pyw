"""Double-click to open agent-monitor (no console window). Optional argument: a config file path."""
import os
import runpy
import sys

sys.argv[0] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "panel.py")
runpy.run_path(sys.argv[0], run_name="__main__")

# NeuroWing Atlas

An interactive, bilingual (English/Persian) research and learning environment for exploring **FlyWire/FAFB connectomes**, visualizing SWC neuron morphologies, and running experimental fly-learning simulations.

> 🇮🇷 **Persian documentation:** [راهنمای فارسی پروژه](README_FA.md)

The application does not load an entire large dataset into browser memory. On the first run, it creates a compact local DuckDB index from the dataset and serves only the data required by the web interface.

## Features

- Interactive English/Persian web interface with an instant language toggle
- Connectome, neural-pathway, neuron, and synapse exploration
- Visualization of real neuron skeletons in SWC format
- 18 built-in experiments, including light, food, odor, wind, heat, touch, slalom, and drawn paths
- Custom task creation and persistence
- Experimental online imitation-learning controller
- Optional full-brain SWC atlas generation

> **Scientific scope:** Neuron IDs, labels, connection and synapse counts, neuropils, raw synapse points, and SWC morphologies come from the dataset. Firing dynamics, sensorimotor mappings, flight commands, and learning behavior are experimental models—not live physiological recordings or a complete biophysical simulation.

## Requirements

- Python 3.10 or newer
- A FlyWire/FAFB dataset stored locally
- Sufficient disk space for the dataset and its generated local index
- Node.js only if you want to run the JavaScript tests (optional)

## Installation

Clone the repository:

```bash
git clone (https://github.com/Ajafarnezhad/neurowing-atlas)
cd neurowing-atlas
```

Create a virtual environment and install the dependencies.

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

If PowerShell prevents virtual-environment activation, run this in the same window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\.venv\Scripts\Activate.ps1
```

### Linux and macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Running the Application

Replace the example path with the location of your FlyWire/FAFB dataset.

### Windows

```powershell
python app.py run --data "D:\FAFB_v783"
```

### Linux and macOS

```bash
python app.py run --data "/path/to/FAFB_v783"
```

On the first run, the application discovers the dataset files and creates a local index at:

```text
<dataset>/.flybrain_lab/flybrain.duckdb
```

The browser normally opens automatically. Otherwise, visit:

```text
http://127.0.0.1:8090
```

To use a different port:

```bash
python app.py run --data "/path/to/FAFB_v783" --port 8080
```

To allow access from other devices on your local network:

```bash
python app.py run --data "/path/to/FAFB_v783" --host 0.0.0.0 --port 8090
```

You are responsible for the relevant firewall and network-security settings. Flask's built-in server is not intended for direct public internet deployment.

## Starting with an Existing Cache

If `.flybrain_lab` has already been generated successfully, skip index preparation with:

```bash
python app.py run --data "/path/to/FAFB_v783" --no-prepare
```

Windows users can also pass the dataset path to the provided launcher:

```powershell
.\run_flybrain_lab.bat "D:\FAFB_v783"
```

`run_A_flybrain.bat` is a convenience launcher for a dataset located specifically at `A:\flybrain`.

## Dataset Commands

Inspect the files detected in the dataset:

```bash
python app.py inspect --data "/path/to/FAFB_v783"
```

Build or validate the local index:

```bash
python app.py prepare --data "/path/to/FAFB_v783"
```

Force a complete index rebuild:

```bash
python app.py prepare --data "/path/to/FAFB_v783" --force
```

## Optional SWC Atlas

The full-brain atlas is not required for the built-in experiments. Build a faster preview with:

```bash
python app.py atlas --data "/path/to/FAFB_v783" --max-segments 32 --workers 4
```

Build a higher-quality version with:

```bash
python app.py atlas --data "/path/to/FAFB_v783" --max-segments 64 --workers 4
```

Atlas generation is resumable. You may stop it with `Ctrl+C` and run the same command again to continue from the saved progress.

## Tests

Check the Python files for syntax errors:

```bash
python -m py_compile app.py swc_atlas.py knowledge_fa.py inspect_dataset.py
```

Run the flight-engine test suite (requires Node.js):

```bash
node tests/flight.test.js
```

## Project Structure

```text
app.py                 Flask server, API, and dataset management
swc_atlas.py           SWC atlas generation and reading
knowledge_fa.py        Persian neuron descriptions
templates/index.html   Main application page
static/                Front-end JavaScript, CSS, and task data
tests/                 Flight and learning-engine tests
requirements.txt       Python dependencies
```

## Additional Documentation

- [Persian project guide](README_FA.md)
- [Persian quick-start guide](QUICK_START_FA.md)
- [Persian research guide](RESEARCH_GUIDE_FA.md)
- [Persian data schema](DATA_SCHEMA_FA.md)
- [Persian experiment template](EXPERIMENT_TEMPLATE_FA.md)
- [Persian changelog](CHANGELOG_FA.md)

## Version

Current version: **3.2.0**

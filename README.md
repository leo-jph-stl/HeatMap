# 3D Weather Globe (Live GFS Heatmap & Wind Streamlines)

An interactive, high-performance 3D Weather Globe visualizing real-time global surface temperatures and wind streamline dynamics, built with **Three.js**, **D3.js**, and **NOAA GFS (Global Forecast System)** data.

![3D Weather Globe Preview](https://raw.githubusercontent.com/leo-jph-stl/HeatMap/main/preview.png)

## Features

- **Real-Time NOAA GFS Data**: Direct integration with NOAA/PACIOOS atmospheric models providing 25 timesteps from **-24h (past) to +48h (forecast)**.
- **Dynamic Clock & Auto-Sync**: Automatically reads local client time and selects the closest matching forecast run with automatic background updates.
- **Screen-Space Wind Streamlines**: Windy.com-style particle animation rendered in screen coordinates, ensuring silky-smooth, razor-sharp streamlines with consistent pixel velocity at any zoom level.
- **Meteorological Color Palette**: Balanced, high-contrast thermal gradients calibrated to natural weather charts (moss greens, warm ochres, amber gold, terracotta, and deep scarlet).
- **Physical 1:1 Grab & Drag**: Custom orbit control mapping maintaining true physical ground adhesion under the cursor from space down to close-up city zoom.
- **Vector Boundaries & Urban Areas**: GPU-rendered 3D vector lines for country borders, administrative provinces, and urban metropolitan extents (Natural Earth).
- **Dynamic City Labels**: Adaptive level-of-detail label rendering with spherical horizon culling.

## Tech Stack

- **Three.js (r128)**: 3D WebGL rendering engine
- **D3.js (v7)**: Linear color scales and data interpolation
- **Node.js**: Data pipeline scripts for fetching and processing OPeNDAP GFS grids

## Getting Started

1. Clone the repository:
   ``bash
   git clone https://github.com/leo-jph-stl/HeatMap.git
   cd HeatMap
   ``

2. Start a local HTTP server:
   ``bash
   npx serve .
   # or
   python -m http.server 8000
   ``

3. Open http://localhost:3000 (or http://localhost:8000) in any modern web browser.

## Refreshing Live Data

To fetch the latest NOAA GFS model runs:
``bash
node fetch_timeline.js
``
This script automatically computes the current model forecast time, queries the PACIOOS OPeNDAP server for temperature and wind components, and updates 	emp_data.js and wind_data.js.

## License

MIT License

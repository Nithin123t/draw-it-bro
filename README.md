# Draw It, Bro!

A multiplayer drawing and guessing game built with React, Vite,
Express, Socket.IO, and WebRTC voice chat.

## Requirements

- Node.js 20 or newer recommended
- npm
- A modern browser

## Project structure

draw-it-bro/
├── package.json
├── vite.config.js
├── server/
│   └── index.js
├── client/
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       └── style.css
└── dist/

## Install and run

Open a terminal in the project root and run:

    npm install

Then start the frontend and backend:

    npm run dev

Open the Vite URL shown in the terminal, usually:

    http://localhost:5173

The frontend runs on port 5173. The backend runs on port 3001.

## Test multiplayer

1. Open the game in one browser window.
2. Enter a nickname and create a room.
3. Copy the six-character room code.
4. Open a second browser window or another browser.
5. Enter a nickname and join using that room code.
6. Once both players are in the lobby, the host starts the game.
7. The artist should see three word-selection buttons.
8. Select one word to enable the drawing tools.
9. The other player guesses the drawing.

## Backend health check

Open:

    http://localhost:3001/health

A running server should return JSON similar to:

    {"ok":true,"rooms":0}

## Production build

Run:

    npm run build

Then start the Express server:

    npm start

The server serves the built frontend from the dist directory.

## Voice chat

Voice chat requires microphone permission and a secure browser context,
such as localhost or HTTPS.

The current implementation uses public STUN servers. Some networks
may require a TURN relay for reliable voice connections.

## Notes

Room data is stored in memory and is lost when the backend restarts.
This project is intended as a starting point and needs additional
security hardening before a public production launch.
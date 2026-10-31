import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN?.split(',') || true
  },
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3001;
const rooms = new Map();

const WORDS = [
  'lion', 'cat', 'dog', 'elephant', 'giraffe', 'monkey', 'penguin', 'frog',
  'shark', 'turtle', 'rabbit', 'owl', 'dinosaur', 'unicorn', 'dragon',
  'banana', 'pizza', 'hamburger', 'ice cream', 'taco', 'potato', 'donut',
  'toothbrush', 'rocket', 'bicycle', 'crown', 'guitar', 'ghost', 'robot',
  'snowman', 'octopus', 'rainbow', 'pirate', 'astronaut', 'mermaid',
  'a lion wearing sunglasses',
  'a cat riding a skateboard',
  'a dog eating pizza',
  'a penguin on a bicycle',
  'a dinosaur brushing its teeth',
  'a monkey wearing a crown',
  'a frog dancing',
  'a shark at a tea party',
  'a chicken flying a spaceship',
  'a sleepy dragon',
  'a banana doing yoga',
  'a robot walking a dog',
  'a giraffe in a tiny car',
  'a ghost eating ice cream',
  'a potato with a superhero cape',
  'a cow on a trampoline',
  'a duck playing drums',
  'a turtle winning a race',
  'a fish wearing a hat',
  'a bear doing ballet',
  'a cat as a detective',
  'a dog dressed like a king',
  'a pizza with a smile',
  'a snail on a skateboard',
  'a unicorn stuck in traffic',
  'a chicken wearing boots'
];

const cleanName = value =>
  String(value || '')
    .trim()
    .replace(/[<>]/g, '')
    .slice(0, 18) || 'Player';

const normalizeGuess = value =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the) /, '');

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: Math.min(
      3,
      Math.floor(room.turnNumber / Math.max(room.players.length, 1)) + 1
    ),
    maxRounds: 3,
    currentTurn: room.currentTurn,
    turnNumber: room.turnNumber,
    totalTurns: room.totalTurns,
    deadline: room.deadline,

    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      isArtist: room.players[room.currentTurn]?.id === player.id
    })),

    strokes: room.strokes,

    guesses: room.guesses.map(guess => ({
      id: guess.id,
      name: guess.name,
      correct: guess.correct,
      text: guess.correct ? 'Guessed it!' : guess.text
    })),

    correctGuessers: [
      ...new Set(
        room.guesses
          .filter(guess => guess.correct)
          .map(guess => guess.id)
      )
    ],

    winner: room.winner
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
}

function clearTurn(room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }

  room.timer = null;
}

function finishGame(room) {
  clearTurn(room);

  room.phase = 'finished';
  room.deadline = null;

  room.winner =
    [...room.players].sort((a, b) => b.score - a.score)[0]?.id || null;

  emitRoom(room);
}

function startTurn(room) {
  clearTurn(room);

  if (room.turnNumber >= room.totalTurns) {
    finishGame(room);
    return;
  }

  room.phase = 'drawing';
  room.strokes = [];
  room.guesses = [];
  room.prompt = null;
  room.promptOptions = [];

  room.currentTurn = room.turnNumber % room.players.length;
  room.deadline = Date.now() + 60000;

  room.promptOptions = [...WORDS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  emitRoom(room);

  // Only the current artist receives the word options.
  io.to(room.players[room.currentTurn].id).emit('turn:prompt', {
    options: room.promptOptions
  });

  room.timer = setTimeout(() => {
    finishTurn(room.code, 'time');
  }, 60000);
}

function finishTurn(code, reason) {
  const room = rooms.get(code);

  if (!room || room.phase !== 'drawing') {
    return;
  }

  clearTurn(room);

  room.phase = 'reveal';
  room.deadline = null;

  const artist = room.players[room.currentTurn];

  const correctGuessers = new Set(
    room.guesses
      .filter(guess => guess.correct)
      .map(guess => guess.id)
  );

  // No artist bonus. Only players who guess correctly receive points.
  const reveal = {
    prompt: room.prompt,
    reason,
    correctCount: correctGuessers.size,
    artistId: artist?.id,
    artistName: artist?.name,

    scores: room.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score
    }))
  };

  io.to(room.code).emit('turn:reveal', reveal);
  emitRoom(room);

  // Automatically advance after the reveal if the host has not advanced.
  room.timer = setTimeout(() => {
    const currentRoom = rooms.get(code);

    if (currentRoom && currentRoom.phase === 'reveal') {
      currentRoom.turnNumber++;
      startTurn(currentRoom);
    }
  }, 5000);
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;

  do {
    code = Array.from(
      { length: 6 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join('');
  } while (rooms.has(code));

  return code;
}

io.on('connection', socket => {
  // Create a room.
  socket.on('room:create', ({ name } = {}, cb = () => {}) => {
    const code = makeCode();

    const player = {
      id: socket.id,
      name: cleanName(name),
      score: 0,
      connected: true
    };

    const room = {
      code,
      hostId: socket.id,
      players: [player],
      phase: 'lobby',
      currentTurn: 0,
      turnNumber: 0,
      totalTurns: 0,
      deadline: null,
      strokes: [],
      guesses: [],
      prompt: null,
      promptOptions: [],
      winner: null,
      timer: null
    };

    rooms.set(code, room);

    socket.join(code);
    socket.data.room = code;

    cb({
      ok: true,
      room: publicRoom(room)
    });

    emitRoom(room);
  });

  // Join an existing room.
  socket.on('room:join', ({ code, name } = {}, cb = () => {}) => {
    code = String(code || '').trim().toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return cb({
        ok: false,
        error: 'Room not found. Check the code and try again.'
      });
    }

    if (room.phase !== 'lobby') {
      return cb({
        ok: false,
        error: 'This game has already started.'
      });
    }

    if (room.players.length >= 4) {
      return cb({
        ok: false,
        error: 'This room is full (4 players max).'
      });
    }

    room.players.push({
      id: socket.id,
      name: cleanName(name),
      score: 0,
      connected: true
    });

    socket.join(code);
    socket.data.room = code;

    cb({
      ok: true,
      room: publicRoom(room)
    });

    emitRoom(room);
  });

  // Start the game.
  socket.on('game:start', (_, cb = () => {}) => {
    const room = rooms.get(socket.data.room);

    if (!room) {
      return cb({
        ok: false,
        error: 'Room not found.'
      });
    }

    if (socket.id !== room.hostId) {
      return cb({
        ok: false,
        error: 'Only the host can start.'
      });
    }

    if (room.phase !== 'lobby' || room.players.length < 2) {
      return cb({
        ok: false,
        error: 'At least two players are needed.'
      });
    }

    room.totalTurns = room.players.length * 3;
    room.turnNumber = 0;

    room.players.forEach(player => {
      player.score = 0;
    });

    room.winner = null;

    cb({ ok: true });

    startTurn(room);
  });

  // Artist chooses a word.
  // The callback is required because the frontend waits for confirmation.
  socket.on(
    'prompt:choose',
    ({ prompt } = {}, cb = () => {}) => {
      const room = rooms.get(socket.data.room);

      if (!room) {
        return cb({
          ok: false,
          error: 'Room not found.'
        });
      }

      if (room.phase !== 'drawing') {
        return cb({
          ok: false,
          error: 'The drawing turn is not active.'
        });
      }

      if (room.players[room.currentTurn]?.id !== socket.id) {
        return cb({
          ok: false,
          error: 'Only the current artist can choose a word.'
        });
      }

      if (!room.promptOptions.includes(prompt)) {
        return cb({
          ok: false,
          error: 'That word is no longer available. Choose one of the displayed options.'
        });
      }

      room.prompt = prompt;
      room.promptOptions = [];

      socket.emit('prompt:chosen', { prompt });

      emitRoom(room);

      cb({
        ok: true,
        prompt
      });
    }
  );

  // Receive and broadcast a drawing stroke.
  socket.on('draw:stroke', stroke => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.phase !== 'drawing' ||
      room.players[room.currentTurn]?.id !== socket.id ||
      !room.prompt
    ) {
      return;
    }

    if (
      !stroke ||
      !Array.isArray(stroke.points) ||
      stroke.points.length > 300 ||
      room.strokes.length > 3000
    ) {
      return;
    }

    const safeStroke = {
      id: String(stroke.id || '').slice(0, 50),

      color: /^#[0-9a-fA-F]{6}$/.test(stroke.color)
        ? stroke.color
        : '#222222',

      width: Math.min(
        20,
        Math.max(1, Number(stroke.width) || 4)
      ),

      points: stroke.points.slice(0, 300).map(point => ({
        x: Math.max(0, Math.min(1, Number(point.x) || 0)),
        y: Math.max(0, Math.min(1, Number(point.y) || 0))
      }))
    };

    room.strokes.push(safeStroke);

    socket.to(room.code).emit('draw:stroke', safeStroke);
  });

  // Undo the latest stroke.
  socket.on('draw:undo', () => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.phase !== 'drawing' ||
      room.players[room.currentTurn]?.id !== socket.id
    ) {
      return;
    }

    const stroke = room.strokes.pop();

    if (stroke) {
      io.to(room.code).emit('draw:undo', stroke.id);
    }
  });

  // Clear the canvas.
  socket.on('draw:clear', () => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.phase !== 'drawing' ||
      room.players[room.currentTurn]?.id !== socket.id
    ) {
      return;
    }

    room.strokes = [];

    io.to(room.code).emit('draw:clear');
  });

  // Submit a guess and award points only to the player who guessed correctly.
  socket.on('guess:submit', ({ text } = {}, cb = () => {}) => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.phase !== 'drawing' ||
      room.players[room.currentTurn]?.id === socket.id ||
      !room.prompt
    ) {
      return cb({
        ok: false,
        error: 'You cannot guess right now.'
      });
    }

    const player = room.players.find(item => item.id === socket.id);

    if (!player) {
      return cb({
        ok: false,
        error: 'You are not in this room.'
      });
    }

    // A player who already guessed correctly cannot score again this turn.
    if (
      room.guesses.some(
        guess => guess.id === socket.id && guess.correct
      )
    ) {
      return cb({
        ok: false,
        error: 'You already guessed correctly this turn.'
      });
    }

    const guessText = String(text || '').trim().slice(0, 100);

    if (!guessText) {
      return cb({
        ok: false,
        error: 'Enter a guess first.'
      });
    }

    const correct =
      normalizeGuess(guessText) === normalizeGuess(room.prompt);

    let points = 0;

    if (correct) {
      const correctCount = new Set(
        room.guesses
          .filter(guess => guess.correct)
          .map(guess => guess.id)
      ).size;

      // First correct guess: 100 points.
      // Second correct guess: 75 points.
      // Third correct guess: 50 points.
      // Later correct guesses: 25 points.
      points = [100, 75, 50][correctCount] || 25;

      player.score += points;
    }

    room.guesses.push({
      id: socket.id,
      name: player.name,
      text: guessText,
      correct,
      points,
      at: Date.now()
    });

    const correctCount = new Set(
      room.guesses
        .filter(guess => guess.correct)
        .map(guess => guess.id)
    ).size;

    cb({
      ok: true,
      correct,
      points,
      rank: correct ? correctCount : null
    });

    io.to(room.code).emit('guess:feed', {
      name: player.name,
      correct,
      text: correct
        ? `Guessed it! +${points} points`
        : guessText
    });

    emitRoom(room);

    // Finish the turn when every non-artist player has guessed correctly.
    const eligibleGuessers = room.players.filter(
      item => item.id !== room.players[room.currentTurn]?.id
    );

    if (
      eligibleGuessers.length > 0 &&
      eligibleGuessers.every(player =>
        room.guesses.some(
          guess => guess.id === player.id && guess.correct
        )
      )
    ) {
      finishTurn(room.code, 'all-guessed');
    }
  });

  // WebRTC voice signaling.
  socket.on('voice:signal', ({ to, data } = {}) => {
    const room = rooms.get(socket.data.room);

    if (
      typeof to === 'string' &&
      data &&
      room?.players.some(player => player.id === to)
    ) {
      io.to(to).emit('voice:signal', {
        from: socket.id,
        data
      });
    }
  });

  // Host manually advances after the reveal.
  socket.on('game:next', (_, cb = () => {}) => {
    const room = rooms.get(socket.data.room);

    if (!room || room.phase !== 'reveal') {
      return cb({
        ok: false,
        error: 'The round is not ready to advance.'
      });
    }

    if (socket.id !== room.hostId) {
      return cb({
        ok: false,
        error: 'Only the host can continue.'
      });
    }

    clearTurn(room);

    room.turnNumber++;

    cb({ ok: true });

    startTurn(room);
  });

  // Start a rematch.
  socket.on('game:rematch', (_, cb = () => {}) => {
    const room = rooms.get(socket.data.room);

    if (!room || room.phase !== 'finished') {
      return cb({
        ok: false,
        error: 'The game is not finished.'
      });
    }

    if (socket.id !== room.hostId) {
      return cb({
        ok: false,
        error: 'Only the host can restart.'
      });
    }

    clearTurn(room);

    room.turnNumber = 0;
    room.totalTurns = 0;

    room.players.forEach(player => {
      player.score = 0;
    });

    room.winner = null;
    room.phase = 'lobby';
    room.currentTurn = 0;
    room.deadline = null;
    room.strokes = [];
    room.guesses = [];
    room.prompt = null;
    room.promptOptions = [];

    cb({ ok: true });

    emitRoom(room);
  });

  // Handle disconnections.
  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms.get(code);

    if (!room) return;

    const player = room.players.find(
      item => item.id === socket.id
    );

    if (player) {
      player.connected = false;
    }

    if (room.phase === 'lobby') {
      room.players = room.players.filter(
        item => item.id !== socket.id
      );

      if (room.hostId === socket.id) {
        room.hostId = room.players[0]?.id || null;
      }

      if (room.players.length === 0) {
        clearTurn(room);
        rooms.delete(code);
      } else {
        emitRoom(room);
      }
    } else {
      emitRoom(room);
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size
  });
});

const clientDist = path.resolve(__dirname, '../dist');

app.use(express.static(clientDist));

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/socket.io')) {
    return next();
  }

  res.sendFile(
    path.join(clientDist, 'index.html'),
    err => {
      if (err) {
        res.status(404).send(
          'Build the client first with npm run build.'
        );
      }
    }
  );
});

server.listen(PORT, () => {
  console.log(`Draw It, Bro! server listening on ${PORT}`);
});
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import {
  Mic,
  MicOff,
  Pencil,
  Users,
  Copy,
  ArrowRight,
  Undo2,
  Trash2,
  Send,
  Volume2,
  Sparkles,
  LogOut,
  Clock3
} from 'lucide-react';
import './style.css';

const socket = io(
  import.meta.env.VITE_SERVER_URL || window.location.origin,
  {
    autoConnect: true,
    transports: ['websocket', 'polling']
  }
);

const COLORS = [
  '#242424',
  '#ff5c5c',
  '#ff9f1c',
  '#ffd43b',
  '#35b779',
  '#339af0',
  '#845ef7',
  '#f06595'
];

function App() {
  const [screen, setScreen] = useState('home');
  const [name, setName] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [options, setOptions] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [guess, setGuess] = useState('');
  const [feed, setFeed] = useState([]);
  const [reveal, setReveal] = useState(null);
  const [color, setColor] = useState('#242424');
  const [brush, setBrush] = useState(5);
  const [muted, setMuted] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('Connecting voice…');
  const [now, setNow] = useState(Date.now());

  const canvasRef = useRef(null);
  const drawRef = useRef(false);
  const localStroke = useRef(null);
  const peerConnections = useRef(new Map());
  const localStream = useRef(null);
  const remoteAudio = useRef(new Map());
  const roomRef = useRef(null);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // Redraw all stored strokes on the canvas.
  const redraw = useCallback(strokes => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    (strokes || []).forEach(stroke => {
      if (!stroke.points?.length) return;

      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();

      ctx.moveTo(
        stroke.points[0].x * rect.width,
        stroke.points[0].y * rect.height
      );

      stroke.points.slice(1).forEach(point => {
        ctx.lineTo(
          point.x * rect.width,
          point.y * rect.height
        );
      });

      ctx.stroke();

      // Render a dot for a single-point stroke.
      if (stroke.points.length === 1) {
        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        ctx.arc(
          stroke.points[0].x * rect.width,
          stroke.points[0].y * rect.height,
          stroke.width / 2,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    });
  }, []);

  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));

    redraw(roomRef.current?.strokes || []);
  }, [redraw]);

  useEffect(() => {
    if (screen !== 'game') return undefined;

    const frame = requestAnimationFrame(fitCanvas);
    window.addEventListener('resize', fitCanvas);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fitCanvas);
    };
  }, [screen, fitCanvas, room?.phase, room?.turnNumber]);

  // Keep the countdown moving.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  // Socket event handlers.
  useEffect(() => {
    const onRoom = updatedRoom => {
      const previous = roomRef.current;

      const turnChanged =
        previous?.code === updatedRoom.code &&
        previous?.turnNumber !== updatedRoom.turnNumber;

      const enteringDrawing =
        updatedRoom.phase === 'drawing' &&
        previous?.phase !== 'drawing';

      // Reset round-specific information only when the round changes.
      // Do not clear options on every room:update: that can hide the
      // word-selection buttons before the artist chooses.
      if (turnChanged || enteringDrawing) {
        setPrompt('');
        setOptions([]);
        setReveal(null);
        setGuess('');
        setNotice('');
        setFeed([]);
        drawRef.current = false;
        localStroke.current = null;
      }

      roomRef.current = updatedRoom;
      setRoom(updatedRoom);
      setScreen('game');

      requestAnimationFrame(() => {
        redraw(updatedRoom.strokes || []);
      });
    };

    const onPrompt = data => {
      // The server sends these options privately to the current artist.
      setPrompt('');
      setOptions(Array.isArray(data?.options) ? data.options : []);
      setReveal(null);
      setGuess('');
      setError('');
    };

    const onChosen = data => {
      setPrompt(data?.prompt || '');
      setOptions([]);
      setError('');
    };

    const onStroke = stroke => {
      setRoom(previous => {
        if (!previous) return previous;

        const updated = {
          ...previous,
          strokes: [...(previous.strokes || []), stroke]
        };

        requestAnimationFrame(() => redraw(updated.strokes));
        return updated;
      });
    };

    const onUndo = strokeId => {
      setRoom(previous => {
        if (!previous) return previous;

        const updated = {
          ...previous,
          strokes: (previous.strokes || []).filter(
            stroke => stroke.id !== strokeId
          )
        };

        requestAnimationFrame(() => redraw(updated.strokes));
        return updated;
      });
    };

    const onClear = () => {
      setRoom(previous =>
        previous ? { ...previous, strokes: [] } : previous
      );

      requestAnimationFrame(() => redraw([]));
    };

    const onFeed = item => {
      setFeed(previous => [...previous.slice(-25), item]);
    };

    const onReveal = data => {
      setReveal(data);
      setOptions([]);
      setPrompt('');
      setNotice(
        data.reason === 'time' ? 'Time is up!' : 'Nice round!'
      );
    };

    const onVoiceSignal = async ({ from, data }) => {
      try {
        let peer = peerConnections.current.get(from);

        if (!peer) {
          peer = await makePeer(from, false);
        }

        if (data.description) {
          await peer.setRemoteDescription(data.description);

          if (data.description.type === 'offer') {
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);

            socket.emit('voice:signal', {
              to: from,
              data: { description: peer.localDescription }
            });
          }
        } else if (data.candidate) {
          await peer.addIceCandidate(data.candidate);
        }
      } catch (voiceError) {
        console.warn('Voice signal error:', voiceError);
      }
    };

    socket.on('room:update', onRoom);
    socket.on('turn:prompt', onPrompt);
    socket.on('prompt:chosen', onChosen);
    socket.on('draw:stroke', onStroke);
    socket.on('draw:undo', onUndo);
    socket.on('draw:clear', onClear);
    socket.on('guess:feed', onFeed);
    socket.on('turn:reveal', onReveal);
    socket.on('voice:signal', onVoiceSignal);

    return () => {
      socket.off('room:update', onRoom);
      socket.off('turn:prompt', onPrompt);
      socket.off('prompt:chosen', onChosen);
      socket.off('draw:stroke', onStroke);
      socket.off('draw:undo', onUndo);
      socket.off('draw:clear', onClear);
      socket.off('guess:feed', onFeed);
      socket.off('turn:reveal', onReveal);
      socket.off('voice:signal', onVoiceSignal);
    };
  }, [redraw]);

  async function makePeer(peerId, initiator) {
    let peer = peerConnections.current.get(peerId);
    if (peer) return peer;

    peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    peerConnections.current.set(peerId, peer);

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        peer.addTrack(track, localStream.current);
      });
    }

    peer.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('voice:signal', {
          to: peerId,
          data: { candidate: event.candidate }
        });
      }
    };

    peer.ontrack = event => {
      let audio = remoteAudio.current.get(peerId);

      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        remoteAudio.current.set(peerId, audio);
      }

      audio.srcObject = event.streams[0];
      audio.play().catch(() => {});
    };

    peer.onconnectionstatechange = () => {
      const connected = [...peerConnections.current.values()].some(
        item => item.connectionState === 'connected'
      );

      setVoiceStatus(
        connected ? 'Voice connected' : 'Voice connecting…'
      );
    };

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      socket.emit('voice:signal', {
        to: peerId,
        data: { description: peer.localDescription }
      });
    }

    return peer;
  }

  async function enableVoice() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Voice requires HTTPS or localhost and a supported browser.'
        );
      }

      localStream.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      localStream.current.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });

      const players = roomRef.current?.players || [];
      const peers = players.filter(
        player => player.id !== socket.id && player.connected
      );

      for (const player of peers) {
        await makePeer(
          player.id,
          socket.id.localeCompare(player.id) < 0
        );
      }

      setVoiceStatus('Microphone ready');
      setError('');
    } catch (voiceError) {
      setError(
        voiceError.message ||
        'Could not access microphone. Check browser permissions.'
      );

      setVoiceStatus('Voice unavailable');
    }
  }

  useEffect(() => {
    if (
      room?.phase !== 'drawing' &&
      room?.phase !== 'lobby'
    ) {
      return;
    }

    if (!localStream.current) return;

    const knownPeers = new Set(peerConnections.current.keys());

    (room.players || [])
      .filter(player =>
        player.id !== socket.id &&
        !knownPeers.has(player.id) &&
        player.connected
      )
      .forEach(player => {
        if (socket.id.localeCompare(player.id) < 0) {
          makePeer(player.id, true).catch(() => {});
        }
      });
  }, [room?.players, room?.phase]);

  useEffect(() => {
    if (!localStream.current) return;

    localStream.current.getAudioTracks().forEach(track => {
      track.enabled = !muted;
    });
  }, [muted]);

  useEffect(() => {
    return () => {
      localStream.current?.getTracks().forEach(track => track.stop());

      peerConnections.current.forEach(peer => peer.close());
      peerConnections.current.clear();

      remoteAudio.current.forEach(audio => {
        audio.pause();
        audio.srcObject = null;
      });

      remoteAudio.current.clear();
    };
  }, []);

  const call = (event, payload) =>
    new Promise(resolve => {
      socket.emit(event, payload, resolve);
    });

  async function createRoom() {
    const nickname = name.trim();

    if (!nickname) {
      setError('Please enter a nickname first.');
      return;
    }

    setError('');

    const result = await call('room:create', {
      name: nickname
    });

    if (result?.ok) {
      roomRef.current = result.room;
      setRoom(result.room);
      setScreen('game');
      setFeed([]);
      setReveal(null);
    } else {
      setError(result?.error || 'Could not create room.');
    }
  }

  async function joinRoom() {
    const nickname = name.trim();
    const roomCode = codeInput.trim().toUpperCase();

    if (!nickname) {
      setError('Please enter a nickname first.');
      return;
    }

    if (!roomCode) {
      setError('Enter the room code first.');
      return;
    }

    setError('');

    const result = await call('room:join', {
      name: nickname,
      code: roomCode
    });

    if (result?.ok) {
      roomRef.current = result.room;
      setRoom(result.room);
      setScreen('game');
      setFeed([]);
      setReveal(null);
    } else {
      setError(result?.error || 'Could not join room.');
    }
  }

  async function startGame() {
    const result = await call('game:start', {});

    if (!result?.ok) {
      setError(result?.error || 'Could not start game.');
    } else {
      setFeed([]);
      setReveal(null);
      setError('');
    }
  }

  // Wait for server confirmation before enabling drawing.
  async function choosePrompt(selectedPrompt) {
    if (!selectedPrompt || !options.includes(selectedPrompt)) {
      return;
    }

    setError('');

    const result = await call('prompt:choose', {
      prompt: selectedPrompt
    });

    if (result?.ok) {
      setPrompt(selectedPrompt);
      setOptions([]);
    } else {
      setError(result?.error || 'Could not select that word.');
    }
  }

  function getPoint(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    return {
      x: Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width)
      ),
      y: Math.max(
        0,
        Math.min(1, (event.clientY - rect.top) / rect.height)
      )
    };
  }

  function drawSegment(stroke) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.points.length === 1) {
      const point = stroke.points[0];

      ctx.beginPath();
      ctx.arc(
        point.x * rect.width,
        point.y * rect.height,
        stroke.width / 2,
        0,
        Math.PI * 2
      );
      ctx.fill();
      return;
    }

    const previous = stroke.points[stroke.points.length - 2];
    const current = stroke.points[stroke.points.length - 1];

    ctx.beginPath();
    ctx.moveTo(
      previous.x * rect.width,
      previous.y * rect.height
    );
    ctx.lineTo(
      current.x * rect.width,
      current.y * rect.height
    );
    ctx.stroke();
  }

  function pointerDown(event) {
    if (!canDraw || room?.phase !== 'drawing' || !prompt) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    drawRef.current = true;

    const point = getPoint(event);

    localStroke.current = {
      id: `${socket.id}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
      color,
      width: brush,
      points: [point]
    };

    drawSegment(localStroke.current);
  }

  function pointerMove(event) {
    if (!drawRef.current || !localStroke.current) return;

    event.preventDefault();

    const point = getPoint(event);
    localStroke.current.points.push(point);

    drawSegment(localStroke.current);
  }

  function pointerUp() {
    if (!drawRef.current) return;

    drawRef.current = false;

    if (localStroke.current) {
      const stroke = localStroke.current;

      socket.emit('draw:stroke', stroke);

      setRoom(previous =>
        previous
          ? {
              ...previous,
              strokes: [...(previous.strokes || []), stroke]
            }
          : previous
      );

      localStroke.current = null;
    }
  }

  function undo() {
    if (!canDraw) return;
    socket.emit('draw:undo');
  }

  function clearCanvas() {
    if (!canDraw) return;

    if (window.confirm('Clear your drawing?')) {
      socket.emit('draw:clear');
    }
  }

  async function submitGuess(event) {
    event.preventDefault();

    const value = guess.trim();
    if (!value) return;

    const result = await call('guess:submit', {
      text: value
    });

    if (result?.ok) {
      setGuess('');

      if (result.correct) {
        setNotice('Correct guess! 🎉');
      } else {
        setNotice('Guess submitted!');
      }
    } else {
      setError(result?.error || 'Could not submit your guess.');
    }
  }

  function copyCode() {
    if (!room?.code) return;

    navigator.clipboard?.writeText(room.code)
      .then(() => setNotice('Room code copied!'))
      .catch(() => setNotice(`Room code: ${room.code}`));
  }

  function leaveRoom() {
    if (!window.confirm('Leave the room?')) return;

    localStream.current?.getTracks().forEach(track => track.stop());
    localStream.current = null;

    peerConnections.current.forEach(peer => peer.close());
    peerConnections.current.clear();

    remoteAudio.current.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });

    remoteAudio.current.clear();

    setRoom(null);
    roomRef.current = null;
    setOptions([]);
    setPrompt('');
    setReveal(null);
    setFeed([]);
    setGuess('');
    setError('');
    setNotice('');
    setScreen('home');

    socket.disconnect();
    socket.connect();
  }

  const me = room?.players?.find(player => player.id === socket.id);

  const currentArtist = room?.players?.[room?.currentTurn];

  const isArtist = Boolean(
    room &&
    currentArtist &&
    currentArtist.id === socket.id
  );

  const canDraw = Boolean(
    room?.phase === 'drawing' &&
    isArtist &&
    prompt
  );

  const timeLeft = room?.deadline
    ? Math.max(0, Math.ceil((room.deadline - now) / 1000))
    : 0;

  if (screen === 'home') {
    return (
      <main className="home">
        <div className="brand">
          <div className="brand-icon">
            <Pencil size={26} />
          </div>
          <span>DRAW IT, BRO!</span>
          <span className="beta">PARTY GAME</span>
        </div>

        <section className="hero">
          <div className="sticker sticker-one">😂</div>
          <div className="sticker sticker-two">🎨</div>

          <p className="eyebrow">
            <Sparkles size={15} /> FRIENDS + DOODLES + CHAOS
          </p>

          <h1>
            Bad drawings.
            <br />
            <span>Best memories.</span>
          </h1>

          <p className="subhead">
            Grab your friends, draw something ridiculous, and see who can guess it.
          </p>

          <div className="sample-art">
            <svg
              viewBox="0 0 420 160"
              role="img"
              aria-label="A silly potato doodle"
            >
              <path
                d="M65 91 C42 61 67 25 102 39 C126 16 163 44 158 74 C183 103 155 136 124 128 C92 147 61 124 65 91Z"
                fill="#f8d46a"
                stroke="#302d2b"
                strokeWidth="4"
                strokeLinecap="round"
              />
              <circle cx="98" cy="79" r="4" fill="#302d2b" />
              <circle cx="132" cy="77" r="4" fill="#302d2b" />
              <path
                d="M105 96 Q116 108 128 94"
                fill="none"
                stroke="#302d2b"
                strokeWidth="4"
                strokeLinecap="round"
              />
              <path
                d="M95 57 L105 49 M133 54 L143 62"
                stroke="#302d2b"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                d="M88 129 L80 147 M140 130 L151 145 M58 93 L42 86 M162 90 L180 85"
                stroke="#302d2b"
                strokeWidth="4"
                strokeLinecap="round"
              />
              <path
                d="M226 108 Q246 77 267 102 T310 93 T350 105"
                fill="none"
                stroke="#7d5fff"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray="1 10"
              />
              <path
                d="M270 40 l6 15 16 1 -12 10 4 16 -14 -9 -14 9 4 -16 -12 -10 16 -1Z"
                fill="#ff8c42"
                stroke="#302d2b"
                strokeWidth="2"
              />
            </svg>

            <div className="art-caption">
              the artist's best work, probably
            </div>
          </div>

          <div className="entry-card">
            <label htmlFor="name">YOUR NICKNAME</label>

            <input
              id="name"
              value={name}
              maxLength={18}
              onChange={event => setName(event.target.value)}
              placeholder="e.g. Picasso's Cousin"
            />

            <p className="name-hint">
              Everyone enters their own nickname before creating or joining.
            </p>

            <button
              className="primary full"
              onClick={createRoom}
              disabled={!name.trim()}
            >
              <Users size={18} />
              Create a room
              <ArrowRight size={18} />
            </button>

            <div className="or">
              <span />
              OR JOIN YOUR FRIENDS
              <span />
            </div>

            <div className="join-row">
              <input
                aria-label="Room code"
                value={codeInput}
                onChange={event =>
                  setCodeInput(
                    event.target.value.toUpperCase().slice(0, 6)
                  )
                }
                placeholder="6-LETTER CODE"
                maxLength={6}
              />

              <button
                className="secondary"
                onClick={joinRoom}
                disabled={!name.trim() || !codeInput.trim()}
              >
                Join room
              </button>
            </div>

            {error && <p className="error">{error}</p>}
          </div>

          <div className="features">
            <span><Mic size={15} /> Live voice</span>
            <span><Users size={15} /> 2–4 players</span>
            <span><Clock3 size={15} /> 3 rounds</span>
          </div>
        </section>

        <footer>Made for friends who can't draw. 💛</footer>
      </main>
    );
  }

  return (
    <main className="game-shell">
      <header className="topbar">
        <button className="brand small" onClick={leaveRoom}>
          <div className="brand-icon">
            <Pencil size={20} />
          </div>
          <span>DRAW IT, BRO!</span>
        </button>

        <div className="room-pill">
          <span>ROOM</span>
          <strong>{room?.code}</strong>
          <button title="Copy room code" onClick={copyCode}>
            <Copy size={15} />
          </button>
        </div>

        <button
          className={`voice-button ${muted ? 'muted' : ''}`}
          onClick={() => {
            if (!localStream.current) {
              enableVoice();
            } else {
              setMuted(value => !value);
            }
          }}
        >
          {muted ? <MicOff size={17} /> : <Mic size={17} />}
          <span>
            {localStream.current
              ? muted
                ? 'Muted'
                : 'Mic on'
              : 'Join voice'}
          </span>
        </button>
      </header>

      {room?.phase === 'lobby' ? (
        <section className="lobby card">
          <div className="section-kicker">THE HANGOUT</div>

          <h1>
            Waiting for the crew<span className="dot">.</span>
          </h1>

          <p>Share the room code and get your friends in here.</p>

          <button className="code-big" onClick={copyCode}>
            {room.code}
            <Copy size={18} />
          </button>

          <div className="player-list">
            {room.players.map((player, index) => (
              <div className="player-chip" key={player.id}>
                <div className={`avatar avatar-${index}`}>
                  {['😎', '🤠', '🐸', '🦄'][index]}
                </div>

                <div>
                  <strong>
                    {player.name}
                    {player.id === room.hostId ? ' (host)' : ''}
                  </strong>

                  <small>
                    {player.id === socket.id
                      ? 'That’s you!'
                      : 'Ready to draw'}
                  </small>
                </div>

                <span className="online-dot" />
              </div>
            ))}
          </div>

          <div className="lobby-bottom">
            <span>
              {room.players.length}/4 players · Need at least 2
            </span>

            {room.hostId === socket.id ? (
              <button
                className="primary"
                disabled={room.players.length < 2}
                onClick={startGame}
              >
                Start the chaos
                <ArrowRight size={17} />
              </button>
            ) : (
              <span className="waiting">Waiting for host…</span>
            )}
          </div>

          {error && <p className="error">{error}</p>}
        </section>
      ) : room?.phase === 'finished' ? (
        <section className="finished card">
          <div className="confetti">🎉 ✨ 🎨 ✨ 🎉</div>

          <p className="section-kicker">THE RESULTS ARE IN</p>

          <h1>
            Masterpiece? <span className="dot">Questionable.</span>
          </h1>

          <p>But the memories are forever.</p>

          <div className="leaderboard">
            {[...(room.players || [])]
              .sort((a, b) => b.score - a.score)
              .map((player, index) => (
                <div className="leader" key={player.id}>
                  <span className="rank">
                    {['🥇', '🥈', '🥉', '4'][index]}
                  </span>

                  <strong>
                    {player.name}
                    {player.id === room.winner ? ' 🏆' : ''}
                  </strong>

                  <span>{player.score} pts</span>
                </div>
              ))}
          </div>

          {room.hostId === socket.id && (
            <button
              className="primary full"
              onClick={async () => {
                const result = await call('game:rematch', {});

                if (!result?.ok) {
                  setError(result?.error || 'Could not start rematch.');
                } else {
                  setFeed([]);
                  setReveal(null);
                  setError('');
                }
              }}
            >
              Run it back <ArrowRight size={18} />
            </button>
          )}

          <button
            className="secondary full exit-home"
            onClick={leaveRoom}
          >
            Exit to home <LogOut size={17} />
          </button>
        </section>
      ) : (
        <>
          <div className="game-meta">
            <div>
              <span className="round-tag">
                ROUND{' '}
                {Math.min(
                  3,
                  Math.floor(
                    (room?.turnNumber || 0) /
                    (room?.players?.length || 1)
                  ) + 1
                )}{' '}
                / 3
              </span>

              <h2>
                {room?.phase === 'reveal'
                  ? 'The reveal!'
                  : isArtist
                    ? 'Your turn to draw!'
                    : `${currentArtist?.name || 'Someone'} is drawing…`}
              </h2>
            </div>

            <div className="timer">
              <Clock3 size={17} />
              <strong>
                {room?.phase === 'drawing' ? timeLeft : '—'}s
              </strong>
            </div>
          </div>

          <div className="play-layout">
            <section className="canvas-card">
              <div className="canvas-head">
                <span>
                  {room?.phase === 'reveal'
                    ? 'ANSWER REVEALED'
                    : canDraw
                      ? 'YOUR SECRET PROMPT'
                      : 'GUESS THE DRAWING'}
                </span>

                {canDraw && (
                  <div className="draw-actions">
                    <button
                      title="Undo last stroke"
                      onClick={undo}
                    >
                      <Undo2 size={16} />
                    </button>

                    <button
                      title="Clear canvas"
                      onClick={clearCanvas}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>

              {/* Word selection remains visible until a word is chosen. */}
              <div className="prompt-line">
                {room?.phase === 'reveal' ? (
                  <strong>
                    {reveal?.prompt || 'Round complete!'}
                  </strong>
                ) : isArtist &&
                  room?.phase === 'drawing' &&
                  options.length > 0 ? (
                  <div className="prompt-options">
                    <p>Pick one to draw:</p>

                    {options.map(option => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => choosePrompt(option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                ) : canDraw ? (
                  <strong>Your word: {prompt}</strong>
                ) : room?.phase === 'drawing' ? (
                  <strong>
                    {isArtist
                      ? 'Choose a word to start drawing'
                      : `✏️ ${currentArtist?.name || 'Someone'} is drawing. Guess the word!`}
                  </strong>
                ) : (
                  <strong>Ready…</strong>
                )}
              </div>

              <div
                className={`canvas-wrap ${canDraw ? 'is-drawable' : ''}`}
              >
                <canvas
                  ref={canvasRef}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={pointerUp}
                  onPointerLeave={pointerUp}
                  aria-label="Shared drawing canvas"
                />

                <div className="canvas-watermark">
                  DRAW IT, BRO ✏️
                </div>

                {room?.phase === 'reveal' && (
                  <div className="reveal-banner">
                    It was: <strong>{reveal?.prompt || 'Unknown'}</strong>
                  </div>
                )}
              </div>

              {canDraw && (
                <div className="toolbox">
                  <div className="colors">
                    {COLORS.map(selectedColor => (
                      <button
                        key={selectedColor}
                        type="button"
                        aria-label={`Brush color ${selectedColor}`}
                        className={
                          color === selectedColor ? 'selected' : ''
                        }
                        style={{ background: selectedColor }}
                        onClick={() => setColor(selectedColor)}
                      />
                    ))}
                  </div>

                  <div className="brush-size">
                    <span>BRUSH</span>

                    <input
                      aria-label="Brush size"
                      type="range"
                      min="2"
                      max="14"
                      value={brush}
                      onChange={event =>
                        setBrush(Number(event.target.value))
                      }
                    />
                  </div>
                </div>
              )}

              {room?.phase === 'drawing' && !isArtist && (
                <form className="guess-form" onSubmit={submitGuess}>
                  <input
                    value={guess}
                    onChange={event => setGuess(event.target.value)}
                    placeholder="What's that masterpiece?"
                    maxLength={100}
                    disabled={(room.guesses || []).some(
                      guess => guess.id === socket.id && guess.correct
                    )}
                  />

                  <button
                    className="primary"
                    type="submit"
                    aria-label="Send guess"
                    disabled={(room.guesses || []).some(
                      item => item.id === socket.id && item.correct
                    )}
                  >
                    <Send size={17} />
                  </button>
                </form>
              )}

              {room?.phase === 'reveal' &&
                room.hostId === socket.id && (
                  <button
                    className="primary full next-turn"
                    onClick={async () => {
                      const result = await call('game:next', {});

                      if (!result?.ok) {
                        setError(
                          result?.error || 'Could not start the next turn.'
                        );
                      }
                    }}
                  >
                    Next drawing <ArrowRight size={17} />
                  </button>
                )}
            </section>

            <aside className="side-panel">
              <section className="side-card">
                <div className="side-title">
                  <Users size={17} />
                  THE CREW
                  <span>{room?.players?.length}/4</span>
                </div>

                {room?.players?.map((player, index) => (
                  <div className="score-row" key={player.id}>
                    <div className={`mini-avatar avatar-${index}`}>
                      {['😎', '🤠', '🐸', '🦄'][index]}
                    </div>

                    <div className="score-name">
                      <strong>
                        {player.name}
                        {player.id === socket.id ? ' (you)' : ''}
                      </strong>

                      <small>
                        {player.id === currentArtist?.id
                          ? '✏️ Artist'
                          : player.connected
                            ? 'In the room'
                            : 'Reconnecting…'}
                      </small>
                    </div>

                    <b>{player.score}</b>
                  </div>
                ))}
              </section>

              <section className="side-card guesses">
                <div className="side-title">
                  <Sparkles size={17} />
                  GUESS FEED
                </div>

                <div className="feed-list">
                  {feed.length === 0 ? (
                    <p className="feed-empty">
                      The guesses will appear here. Get ready for some masterpieces.
                    </p>
                  ) : (
                    feed.slice(-12).map((item, index) => (
                      <div
                        className={`feed-item ${item.correct ? 'correct' : ''}`}
                        key={`${item.name}-${index}`}
                      >
                        <span>{item.correct ? '🎯' : '💬'}</span>

                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.text}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="voice-card">
                <div className="voice-icon">
                  <Volume2 size={19} />
                </div>

                <div>
                  <strong>Voice hangout</strong>
                  <small>{voiceStatus}</small>
                </div>

                <button
                  title={muted ? 'Unmute microphone' : 'Mute microphone'}
                  onClick={() => {
                    if (!localStream.current) {
                      enableVoice();
                    } else {
                      setMuted(value => !value);
                    }
                  }}
                >
                  {muted ? <MicOff size={17} /> : <Mic size={17} />}
                </button>
              </section>
            </aside>
          </div>
        </>
      )}

      {notice && (
        <div className="toast" onClick={() => setNotice('')}>
          {notice}
          <button type="button" aria-label="Dismiss notification">×</button>
        </div>
      )}

      {error && (
        <div className="toast error-toast" onClick={() => setError('')}>
          {error}
          <button type="button" aria-label="Dismiss error">×</button>
        </div>
      )}

      <footer className="game-footer">
        <span>Be kind. Draw badly. Laugh loudly.</span>
        <button onClick={leaveRoom}>
          <LogOut size={14} /> Leave room
        </button>
      </footer>
    </main>
  );
}

export default App;

createRoot(document.getElementById('root')).render(<App />);
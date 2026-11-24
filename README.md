# Chess Online

Play chess with a friend in the browser. Create a game, send the link, play.

- Moves sync live over WebSockets, and the server checks every move with [chess.js](https://github.com/jhlywa/chess.js), so nobody can cheat by editing their browser.
- Optional clocks (3+2, 5+0, 10+0, 15+10, 30+0, or custom), run by the server.
- Click or drag to move, with legal-move dots, check highlight, and a promotion picker.
- Resign, draw offers, and rematch (colours swap).
- Refresh or lose connection and you're put back in your seat. Extra people who open the link watch as spectators.
- Works on phones.

Games are kept in memory, so they disappear when the server restarts. Games idle for 24 hours are removed.

## Run it locally

You need Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. To test online play by yourself, open the invite link in a private window.

To play a friend on the same Wi-Fi, give them `http://<your-computer's-local-IP>:3000/g/...`.

## Put it online (free, about 10 minutes)

The game needs a server that stays running and supports WebSockets. [Render](https://render.com) works well:

1. Push this repo to GitHub (already done if you're reading this there).
2. On Render: **New → Web Service**, then connect this repository.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Deploy. Render gives you a URL like `https://chess-online-xxxx.onrender.com`. Share game links from there.

Render's free tier goes to sleep after about 15 minutes of no traffic. The first visit afterwards takes around 30 seconds to wake up, and any games in progress are lost. A paid instance or [Fly.io](https://fly.io) / [Railway](https://railway.app) avoids this. The app reads the `PORT` environment variable, so those work as well.

## How it works

| File | What it does |
| --- | --- |
| `server.js` | Express + Socket.IO server. Creates games, gives out seats, validates moves, runs clocks, and ends games. |
| `public/index.html` | Lobby: choose time control and colour, create a game. |
| `public/game.html`, `public/app.js` | Game page: draws the board, handles input, shows clocks, move list and buttons. |
| `public/style.css` | Styles. |

Each player gets a secret seat token, saved in their browser. It's how the server knows who you are when you reconnect. The shareable link doesn't contain it, so sharing the link can't give away your seat.

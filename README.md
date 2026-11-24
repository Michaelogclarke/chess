# Chess Online

Play chess online in the browser. Join an open game from the lobby, post your own, or send a private link to a friend.

- **Open games lobby:** the home page shows a live list of public games waiting for an opponent. Click Join to play. A game drops off the list once someone joins, or if its creator closes the page.
- **Public or private:** public games are listed in the lobby; private games can only be joined with the link.
- **Nicknames:** pick a display name (or roll a random one). It's remembered in your browser. No accounts or passwords.

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

## Put it online (free, about 5 minutes)

The game needs a server that stays running and supports WebSockets, so static hosts like GitHub Pages or serverless hosts like Vercel won't work. [Render](https://render.com) does, and this repo includes a `render.yaml` that fills in the settings for you.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/michaelogclarke/chess)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click the button above, or in Render choose **New → Blueprint** and pick this repo.
3. Click **Apply**. Render builds and starts the game, then gives you a URL like `https://chess-online-xxxx.onrender.com`.
4. Send that URL to your friend.

Every push to `main` redeploys automatically.

If the repo is private, the button may not work. Use **New → Blueprint** instead, and give Render access to the repo when it asks.

Render's free tier goes to sleep after about 15 minutes of no traffic. The first visit afterwards takes around 30 seconds to wake up, and any games in progress are lost. A paid instance avoids this. The app reads the `PORT` environment variable, so [Fly.io](https://fly.io) and [Railway](https://railway.app) work too.

### Quick test without hosting

Run `npm start` on your computer, then in another terminal run `npx localtunnel --port 3000`. It prints a temporary public URL you can send to a friend. It works while your computer stays on.

## How it works

| File | What it does |
| --- | --- |
| `server.js` | Express + Socket.IO server. Creates games, gives out seats, validates moves, runs clocks, and ends games. |
| `public/index.html` | Lobby: nickname, live list of open games, and the create-game form. |
| `public/game.html`, `public/app.js` | Game page: draws the board, handles input, shows clocks, move list and buttons. |
| `public/style.css` | Styles. |
| `public/pieces/` | SVG piece images. |
| `render.yaml` | Render deployment settings. |

Each player gets a secret seat token, saved in their browser. It's how the server knows who you are when you reconnect. The shareable link doesn't contain it, so sharing the link can't give away your seat.

## Credits

Piece images are the "cburnett" set by [Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), the same set Lichess uses. They're licensed under GPLv2+ (also available under BSD and GFDL on [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces)).

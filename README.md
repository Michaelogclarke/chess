# Chess Online

Play chess online in the browser. Join an open game from the lobby, post your own, or send a private link to a friend.

- **Open games lobby:** the home page shows a live list of public games waiting for an opponent. Click Join to play. A game drops off the list once someone joins, or if its creator closes the page.
- **Public or private:** public games are listed in the lobby; private games can only be joined with the link.
- **Nicknames:** pick a display name (or roll a random one). It's remembered in your browser. No accounts or passwords.
- **Accounts (optional):** sign up with a username and password. Guests can still play casual games.
- **Ratings:** rated games update separate Bullet, Blitz, Rapid and Classical ratings using Glicko-2 (the system Lichess uses). A "?" marks a provisional rating that hasn't settled yet. Games that end before both players move don't count.
- **Game history and profiles:** every game involving an account is saved. Profiles show ratings, win/draw/loss records and recent games, and any saved game can be reopened and reviewed.
- **Leaderboard** for each speed.
- **Move review:** step through the game with ⏮ ◀ ▶ ⏭, the arrow keys, or by clicking a move. Works during a game too; touch the board or press "Back to the game" to return.
- **Stockfish game review:** after a game ends, Stockfish analyses every move. You get each player's accuracy, inaccuracies (?!), mistakes (?) and blunders (??), an evaluation graph and bar, and an arrow showing the engine's best move. It runs in your browser, so it costs the server nothing, and it's locked during play so nobody can use it to cheat.

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

Without a database the app runs in guest-only mode: no accounts, ratings or saved games. To turn those on, point it at a Postgres database:

```bash
DATABASE_URL=postgres://user:password@localhost/chess npm start
```

Tables are created automatically on startup.

## Put it online (free, about 15 minutes)

The game runs on [Render](https://render.com), with accounts, ratings and game history stored in a free [Neon](https://neon.tech) Postgres database. Static hosts like GitHub Pages and serverless hosts like Vercel won't work, because the game needs a server that stays running.

### 1. Create the database on Neon

1. Sign up at [neon.tech](https://neon.tech) (the free plan is plenty).
2. Create a project. Pick the region closest to your Render service: Render's default region is Oregon, so choose **AWS US West 2 (Oregon)**. If you choose Frankfurt on Render, pick Frankfurt on Neon too.
3. On the project dashboard, click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`.

Keep that string private: it's the password to your database.

### 2. Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/michaelogclarke/chess)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click the button above, or in Render choose **New → Blueprint** and pick this repo.
3. When it asks for `DATABASE_URL`, paste the Neon connection string.
4. Click **Apply**. Render builds and starts the game and gives you a URL like `https://chess-online-xxxx.onrender.com`.

The database tables are created on the first start. Every push to `main` redeploys automatically.

If you already created the service before adding a database: in Render open the service, go to **Environment**, add `DATABASE_URL` with the Neon string, and save. It redeploys by itself.

If the repo is private, the button may not work. Use **New → Blueprint** instead, and give Render access to the repo when it asks.

### Free tier limits

- Render's free tier sleeps after about 15 minutes with no visitors. The first visit afterwards takes around 30 seconds, and games **in progress** are lost (finished games are safe in the database). The Starter plan (about $7/month) keeps it always on.
- Neon's free tier pauses the database when idle and wakes it in about a second, so you won't notice.

### Quick test without hosting

Run `npm start` on your computer, then in another terminal run `npx localtunnel --port 3000`. It prints a temporary public URL you can send to a friend. It works while your computer stays on.

## How it works

| File | What it does |
| --- | --- |
| `server.js` | Express + Socket.IO server. Creates games, gives out seats, validates moves, runs clocks, and ends games. |
| `db.js` | Postgres connection and table setup. |
| `auth.js` | Sign-up, login, sessions. Passwords are hashed with scrypt. |
| `store.js` | Saving games, updating ratings, leaderboard and profile queries. |
| `glicko2.js` | The Glicko-2 rating calculation. |
| `public/index.html` | Lobby: nickname, live list of open games, and the create-game form. |
| `public/login.html`, `public/leaderboard.html`, `public/profile.html` | Account, leaderboard and player pages. |
| `public/nav.js` | The top bar shared by every page. |
| `public/game.html`, `public/app.js` | Game page: draws the board, handles input, shows clocks, move list and buttons. |
| `public/review.js` | Game review maths: replays moves, grades each one, works out accuracy. |
| `public/engine.js` | Runs Stockfish in a Web Worker and talks to it. |
| `public/style.css` | Styles. |
| `public/pieces/` | SVG piece images. |
| `render.yaml` | Render deployment settings. |

Each player gets a secret seat token, saved in their browser. It's how the server knows who you are when you reconnect. The shareable link doesn't contain it, so sharing the link can't give away your seat. Logged-in players also get their seat back from any device.

## Credits

Piece images are the "cburnett" set by [Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), the same set Lichess uses. They're licensed under GPLv2+ (also available under BSD and GFDL on [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces)).

The review engine is [Stockfish](https://stockfishchess.org) 19 via [stockfish.js](https://github.com/nmrugg/stockfish.js) (the "lite, single-threaded" WASM build), licensed under GPLv3. Move grading and the accuracy formula follow [Lichess's published approach](https://lichess.org/page/accuracy).

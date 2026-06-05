# Sliding Puzzle Stream Game

A live YouTube chat-driven 4×4 sliding puzzle overlay for OBS.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add your YouTube Channel ID
Open `server.js` and replace:
```js
const YOUTUBE_CHANNEL_ID = "YOUR_CHANNEL_ID";
```
Your channel ID looks like `UCxxxxxxxxxxxxxxxxxxxxxx`.
Find it at: https://www.youtube.com/account_advanced

### 3. Add puzzle images
Drop `.jpg`, `.png`, or `.webp` images into the `images/` folder.
Each new puzzle randomly picks one. Recommended size: **400×400px** or square.

### 4. Start the server
```bash
npm start
```

### 5. Add to OBS
- Add a **Browser Source**
- URL: `http://localhost:3000/overlay.html`
- Width: `600`, Height: `700`
- Tick **"Refresh browser when scene becomes active"**

---

## How it works

| Step | What happens |
|------|-------------|
| Stream starts | Server shuffles board, picks random image, starts 20s vote window |
| Chat votes | Viewers type `!B2` (column letter + row number) in chat |
| After 20s | Most-voted valid cell moves into the blank. Ties broken by first vote. |
| Repeat | New 20s window starts. Only cells adjacent to the blank are valid. |
| Solved! | Completion screen shows time, move count, and Top 5 contributors. |

## Voting format
```
!A1  !B3  !D4  etc.
```
- Letter = column (A B C D, left to right)
- Number = row (1 2 3 4, top to bottom)
- Only the highlighted (yellow) cells are valid votes each round.

## Console commands
While the server is running, type in the terminal:
- `new` → Start a new puzzle immediately (new random image)

---

## Notes
- The stream must be **live** for youtube-chat to connect.
- youtube-chat uses the public YouTube page scraper — no API key needed.
- If chat doesn't connect, check your channel ID and that the stream is active.

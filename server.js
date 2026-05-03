const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname + '/public'));

const CHAR_NORMAL = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんー";
const CHAR_VOICED = "がぎぐげござじずぜぞだぢづでどばびぶべぼ";
const CHAR_SEMI = "ぱぴぷぺぽ";
const CHAR_SMALL = "ぁぃぅぇぉゃゅょっ";

function getRandomChar() {
    const r = Math.random();
    if (r < 0.75) return CHAR_NORMAL[Math.floor(Math.random() * CHAR_NORMAL.length)]; // 75%で通常の文字
    if (r < 0.90) return CHAR_VOICED[Math.floor(Math.random() * CHAR_VOICED.length)]; // 15%で濁音
    if (r < 0.95) return CHAR_SEMI[Math.floor(Math.random() * CHAR_SEMI.length)];     // 5%で半濁音
    return CHAR_SMALL[Math.floor(Math.random() * CHAR_SMALL.length)];                 // 5%で小文字
}
const rooms = {};

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = data.roomId;
        if (rooms[roomId]) return socket.emit('errorMsg', 'そのIDは使用中です');
        socket.join(roomId);
        rooms[roomId] = {
            id: roomId, settings: data.settings,
            players: [{ id: socket.id, ready: false }],
            state: null, timer: null
        };
        // 【修正】タイマーデータを除外して送信（RangeError対策）
        socket.emit('roomJoined', { roomId, isHost: true, roomData: { ...rooms[roomId], timer: undefined } });
    });

    socket.on('joinRoom', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players.length >= room.settings.maxPlayers) return socket.emit('errorMsg', '入室できません');
        socket.join(roomId);
        room.players.push({ id: socket.id, ready: false });
        // 【修正】タイマーデータを除外して送信
        socket.emit('roomJoined', { roomId, isHost: false, roomData: { ...room, timer: undefined } });
        io.to(roomId).emit('roomUpdated', { ...room, timer: undefined });
    });

    socket.on('toggleReady', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = !player.ready;
            // 【修正】タイマーデータを除外して送信
            io.to(roomId).emit('roomUpdated', { ...room, timer: undefined });
            if (room.players.every(p => p.ready) && room.players.length == room.settings.maxPlayers) {
                startGame(roomId);
            }
        }
    });

    socket.on('playAction', (data) => {
        const room = rooms[data.roomId];
        // 【修正】ゲーム終了後は入力を受け付けない
        if (!room || !room.state || room.state.isGameOver) return;
        
        const playerIdx = room.players.findIndex(p => p.id === socket.id) + 1;
        if (playerIdx !== room.state.currentPlayer) return;

        const { word, mode, selected } = data;
        const state = room.state;
        const isV = mode === 'V';
        let pts = [], overlapCount = 0;

        for (let i = 0; i < word.length; i++) {
            let r = selected.r + (isV ? i : 0), c = selected.c + (!isV ? i : 0);
            if (r >= state.ROWS || c >= state.COLS) return;
            if (state.boardData[r][c]) {
                if (state.boardData[r][c].char !== word[i]) return;
                overlapCount++;
            }
            pts.push({ r, c, char: word[i] });
        }
        if (overlapCount === 0) return;

        pts.forEach(p => {
            if (!state.boardData[p.r][p.c]) {
                state.boardData[p.r][p.c] = { char: p.char, owner: playerIdx };
            }
        });

        processFloodFill(state, playerIdx, overlapCount);
        state.logs.push({ msg: `P${playerIdx}: 「${word}」を配置`, pIdx: playerIdx });
        nextTurn(data.roomId);
    });

    socket.on('passAction', (roomId) => {
        const room = rooms[roomId];
        const playerIdx = room.players.findIndex(p => p.id === socket.id) + 1;
        // 【修正】ゲーム終了後はパスを受け付けない
        if (room && room.state && !room.state.isGameOver && playerIdx === room.state.currentPlayer) {
            room.state.logs.push({ msg: `P${playerIdx}: パスしました`, pIdx: playerIdx });
            nextTurn(roomId);
        }
    });

    socket.on('surrender', (roomId) => {
        const room = rooms[roomId];
        if (room && room.state && !room.state.isGameOver) {
            const playerIdx = room.players.findIndex(p => p.id === socket.id) + 1;
            room.state.logs.push({ msg: `P${playerIdx}が降参しました`, pIdx: playerIdx });
            room.state.isGameOver = true;
            // 【修正】誰も操作できないように currentPlayer をリセット
            room.state.currentPlayer = null;
            clearInterval(room.timer);
            io.to(roomId).emit('gameOver', room.state);
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    if (room.timer) clearInterval(room.timer);
                    delete rooms[roomId];
                } else {
                    // 【修正】タイマーデータを除外して送信
                    io.to(roomId).emit('roomUpdated', { ...room, timer: undefined });
                }
                break;
            }
        }
    });
});

function startGame(roomId) {
    const room = rooms[roomId];
    let ROWS = 10, COLS = 10;
    if(room.settings.size === 'medium'){ ROWS = 15; COLS = 12; }
    else if(room.settings.size === 'large'){ ROWS = 20; COLS = 15; }

    const boardData = Array(ROWS).fill().map(() => Array(COLS).fill(null));
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (Math.random() < parseFloat(room.settings.density)) {
                boardData[r][c] = { char: getRandomChar(), owner: 0 };
            }
        }
    }

    room.state = {
        ROWS, COLS, boardData,
        MAX_PLAYERS: room.settings.maxPlayers,
        ownership: Array(ROWS).fill().map(() => Array(COLS).fill(0)),
        cellValues: Array(ROWS).fill().map(() => Array(COLS).fill(0)),
        currentPlayer: 1,
        turnCounts: Array(room.players.length + 1).fill(1),
        timeLeft: 120,
        logs: [{ msg: `ゲーム開始！`, pIdx: 0 }],
        isGameOver: false
    };

    io.to(roomId).emit('gameStarted', room.state);
    startServerTimer(roomId);
}

function startServerTimer(roomId) {
    const room = rooms[roomId];
    if (room.timer) clearInterval(room.timer);
    room.state.timeLeft = 120;
    
    room.timer = setInterval(() => {
        if (!room.state) return clearInterval(room.timer);
        room.state.timeLeft--;
        if (room.state.timeLeft <= 0) {
            room.state.logs.push({ msg: `P${room.state.currentPlayer}: 時間切れパス`, pIdx: room.state.currentPlayer });
            nextTurn(roomId);
        } else {
            io.to(roomId).emit('timerUpdate', room.state.timeLeft);
        }
    }, 1000);
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    const state = room.state;
    const max = room.players.length;

    if (state.currentPlayer === max && state.turnCounts[max] >= 10) {
        state.isGameOver = true;
        // 【修正】誰も操作できないように currentPlayer をリセット
        state.currentPlayer = null;
        clearInterval(room.timer);
        io.to(roomId).emit('gameOver', state);
        return;
    }

    state.currentPlayer = (state.currentPlayer % max) + 1;
    if (state.currentPlayer === 1) state.turnCounts.forEach((v, i) => state.turnCounts[i]++);
    
    startServerTimer(roomId);
    io.to(roomId).emit('stateUpdated', state);
}

function processFloodFill(state, pIdx, overlapCount) {
    let v = Array(state.ROWS).fill().map(() => Array(state.COLS).fill(false));
    const bonus = (state.turnCounts[pIdx] >= 8) ? 2 : 1;

    for (let r = 0; r < state.ROWS; r++) {
        for (let c = 0; c < state.COLS; c++) {
            if (!v[r][c] && !state.ownership[r][c] && !state.boardData[r][c]) {
                let q = [{ r, c }], area = [], edge = false;
                v[r][c] = true;
                let head = 0;
                let boundaryOwners = new Set();

                while (head < q.length) {
                    let cur = q[head++]; area.push(cur);
                    if (cur.r === 0 || cur.r === state.ROWS - 1 || cur.c === 0 || cur.c === state.COLS - 1) edge = true;
                    [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(([dr, dc]) => {
                        let nr = cur.r + dr, nc = cur.c + dc;
                        if (nr >= 0 && nr < state.ROWS && nc >= 0 && nc < state.COLS) {
                            if (state.boardData[nr][nc]) {
                                boundaryOwners.add(state.boardData[nr][nc].owner);
                            } else if (!v[nr][nc] && !state.ownership[nr][nc]) {
                                v[nr][nc] = true; q.push({ r: nr, c: nc });
                            }
                        }
                    });
                }
                if (!edge) {
                    let target;
                    if (boundaryOwners.size === 1 && boundaryOwners.has(0)) {
                        target = -1;
                    } else {
                        target = (overlapCount >= 2) ? pIdx : ((pIdx % (state.turnCounts.length-1)) + 1);
                    }

                    area.forEach(p => { 
                        state.ownership[p.r][p.c] = target; 
                        state.cellValues[p.r][p.c] = (target === -1) ? 1 : bonus;
                    });
                }
            }
        }
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
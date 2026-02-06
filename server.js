const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 伺服器端口
const PORT = process.env.PORT || 3000;

// 遊戲房間存儲
const rooms = new Map();

// 生成房間代碼
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// 生成玩家ID
function generatePlayerId() {
    return Math.random().toString(36).substring(2, 10);
}

// 廣播消息給房間所有玩家
function broadcastToRoom(roomCode, message, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    room.players.forEach(player => {
        if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

// 發送消息給特定玩家
function sendToPlayer(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// 更新房間玩家列表
function updateRoomPlayers(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const playersList = room.players.map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isAI: p.isAI,
        isHost: p.isHost,
        ready: p.ready,
        clicks: p.clicks || 0,
        finished: p.finished || false,
        color: p.color
    }));
    
    broadcastToRoom(roomCode, {
        type: 'playersUpdate',
        players: playersList
    });
}

// 清理空房間
function cleanupRooms() {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        // 移除斷線玩家
        room.players = room.players.filter(p => p.ws.readyState === WebSocket.OPEN);
        
        // 如果房間空了或超過1小時，刪除房間
        if (room.players.length === 0 || (now - room.createdAt) > 3600000) {
            rooms.delete(code);
            console.log(`房間 ${code} 已清理`);
        }
    }
}

// 每5分鐘清理一次
setInterval(cleanupRooms, 300000);

// 創建 HTTP 伺服器
const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, filePath);
    
    const ext = path.extname(filePath);
    const contentType = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif'
    }[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content, 'utf-8');
        }
    });
});

// 創建 WebSocket 伺服器
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('新玩家連線');
    
    let playerRoom = null;
    let playerId = null;
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            console.log('收到消息:', msg.type);
            
            switch (msg.type) {
                case 'createRoom':
                    // 創建房間
                    const roomCode = generateRoomCode();
                    playerId = generatePlayerId();
                    
                    rooms.set(roomCode, {
                        code: roomCode,
                        players: [{
                            id: playerId,
                            ws: ws,
                            name: msg.playerName || '玩家',
                            avatar: '🏃',
                            isAI: false,
                            isHost: true,
                            ready: false,
                            clicks: 0,
                            finished: false,
                            color: '#2ecc71'
                        }],
                        gameStarted: false,
                        createdAt: Date.now()
                    });
                    
                    playerRoom = roomCode;
                    
                    sendToPlayer(ws, {
                        type: 'roomCreated',
                        roomCode: roomCode,
                        playerId: playerId,
                        isHost: true
                    });
                    
                    updateRoomPlayers(roomCode);
                    console.log(`房間 ${roomCode} 創建成功`);
                    break;
                    
                case 'joinRoom':
                    // 加入房間
                    const joinCode = msg.roomCode?.toUpperCase();
                    const room = rooms.get(joinCode);
                    
                    if (!room) {
                        sendToPlayer(ws, {
                            type: 'error',
                            message: '房間不存在或已過期'
                        });
                        return;
                    }
                    
                    if (room.gameStarted) {
                        sendToPlayer(ws, {
                            type: 'error',
                            message: '遊戲已開始，無法加入'
                        });
                        return;
                    }
                    
                    if (room.players.length >= 8) {
                        sendToPlayer(ws, {
                            type: 'error',
                            message: '房間已滿'
                        });
                        return;
                    }
                    
                    playerId = generatePlayerId();
                    playerRoom = joinCode;
                    
                    room.players.push({
                        id: playerId,
                        ws: ws,
                        name: msg.playerName || '玩家',
                        avatar: '🏃',
                        isAI: false,
                        isHost: false,
                        ready: false,
                        clicks: 0,
                        finished: false,
                        color: getPlayerColor(room.players.length)
                    });
                    
                    sendToPlayer(ws, {
                        type: 'joinedRoom',
                        roomCode: joinCode,
                        playerId: playerId,
                        isHost: false
                    });
                    
                    updateRoomPlayers(joinCode);
                    console.log(`玩家加入房間 ${joinCode}`);
                    break;
                    
                case 'toggleReady':
                    // 切換準備狀態
                    if (!playerRoom) return;
                    const r = rooms.get(playerRoom);
                    if (!r) return;
                    
                    const p = r.players.find(pl => pl.id === playerId);
                    if (p) {
                        p.ready = msg.ready;
                        updateRoomPlayers(playerRoom);
                    }
                    break;
                    
                case 'addAI':
                    // 添加AI
                    if (!playerRoom) return;
                    const aiRoom = rooms.get(playerRoom);
                    if (!aiRoom) return;
                    
                    const aiPlayer = aiRoom.players.find(pl => pl.id === playerId);
                    if (!aiPlayer || !aiPlayer.isHost) return;
                    
                    if (aiRoom.players.length >= 8) {
                        sendToPlayer(ws, { type: 'error', message: '房間已滿' });
                        return;
                    }
                    
                    const aiColors = ['#FFD700', '#C0C0C0', '#CD7F32', '#00f5ff', '#ff006e', '#2ecc71', '#8338ec'];
                    const aiNames = ['⚡閃電俠', '👑快打王', '🤖連點機', '💨風之子', '🎯神射手', '🐢穩健者', '🎮練習生'];
                    const aiIndex = aiRoom.players.filter(pl => pl.isAI).length;
                    
                    if (aiIndex < aiNames.length) {
                        aiRoom.players.push({
                            id: generatePlayerId(),
                            ws: null,
                            name: aiNames[aiIndex],
                            avatar: aiNames[aiIndex].substring(0, 2),
                            isAI: true,
                            isHost: false,
                            ready: true,
                            clicks: 0,
                            finished: false,
                            color: aiColors[aiIndex % aiColors.length]
                        });
                        updateRoomPlayers(playerRoom);
                    }
                    break;
                    
                case 'removeAI':
                    // 移除AI
                    if (!playerRoom) return;
                    const rmRoom = rooms.get(playerRoom);
                    if (!rmRoom) return;
                    
                    const rmPlayer = rmRoom.players.find(pl => pl.id === playerId);
                    if (!rmPlayer || !rmPlayer.isHost) return;
                    
                    rmRoom.players = rmRoom.players.filter(pl => !pl.isAI);
                    updateRoomPlayers(playerRoom);
                    break;
                    
                case 'startGame':
                    // 開始遊戲
                    if (!playerRoom) return;
                    const startRoom = rooms.get(playerRoom);
                    if (!startRoom) return;
                    
                    const hostPlayer = startRoom.players.find(pl => pl.id === playerId);
                    if (!hostPlayer || !hostPlayer.isHost) return;
                    
                    const readyPlayers = startRoom.players.filter(pl => pl.ready).length;
                    if (readyPlayers < 2) {
                        sendToPlayer(ws, { type: 'error', message: '至少需要2位玩家準備' });
                        return;
                    }
                    
                    startRoom.gameStarted = true;
                    startRoom.startTime = Date.now();
                    
                    broadcastToRoom(playerRoom, {
                        type: 'gameStarting',
                        countdown: 3
                    });
                    
                    // 倒數計時
                    let count = 3;
                    const countdownInterval = setInterval(() => {
                        count--;
                        if (count > 0) {
                            broadcastToRoom(playerRoom, {
                                type: 'countdown',
                                value: count
                            });
                        } else {
                            clearInterval(countdownInterval);
                            broadcastToRoom(playerRoom, {
                                type: 'gameStarted',
                                startTime: startRoom.startTime
                            });
                            
                            // 啟動AI
                            startRoom.players.forEach(pl => {
                                if (pl.isAI) {
                                    runAI(playerRoom, pl.id);
                                }
                            });
                        }
                    }, 1000);
                    break;
                    
                case 'playerClick':
                    // 玩家點擊
                    if (!playerRoom) return;
                    const clickRoom = rooms.get(playerRoom);
                    if (!clickRoom || !clickRoom.gameStarted) return;
                    
                    const clickPlayer = clickRoom.players.find(pl => pl.id === playerId);
                    if (!clickPlayer || clickPlayer.finished) return;
                    
                    const multiplier = msg.nitro ? 2 : 1;
                    clickPlayer.clicks += multiplier;
                    
                    if (clickPlayer.clicks >= 300) {
                        clickPlayer.finished = true;
                        clickPlayer.finishTime = Date.now() - clickRoom.startTime;
                        
                        broadcastToRoom(playerRoom, {
                            type: 'playerFinished',
                            playerId: playerId,
                            clicks: clickPlayer.clicks,
                            finishTime: clickPlayer.finishTime
                        });
                        
                        checkGameEnd(playerRoom);
                    } else {
                        broadcastToRoom(playerRoom, {
                            type: 'playerClick',
                            playerId: playerId,
                            clicks: clickPlayer.clicks
                        }, ws);
                    }
                    break;
                    
                case 'useNitro':
                    // 使用氮氣
                    if (!playerRoom) return;
                    const nitroRoom = rooms.get(playerRoom);
                    if (!nitroRoom || !nitroRoom.gameStarted) return;
                    
                    broadcastToRoom(playerRoom, {
                        type: 'playerNitro',
                        playerId: playerId
                    });
                    break;
            }
        } catch (err) {
            console.error('處理消息錯誤:', err);
        }
    });
    
    ws.on('close', () => {
        console.log('玩家斷線');
        
        if (playerRoom && rooms.has(playerRoom)) {
            const room = rooms.get(playerRoom);
            room.players = room.players.filter(p => p.id !== playerId);
            
            if (room.players.length === 0) {
                rooms.delete(playerRoom);
                console.log(`房間 ${playerRoom} 已刪除`);
            } else {
                // 如果房主離開，轉移房主
                const hostLeft = !room.players.some(p => p.isHost);
                if (hostLeft && room.players.length > 0) {
                    room.players[0].isHost = true;
                    sendToPlayer(room.players[0].ws, {
                        type: 'becameHost'
                    });
                }
                updateRoomPlayers(playerRoom);
            }
        }
    });
});

// AI 運行
function runAI(roomCode, aiId) {
    const room = rooms.get(roomCode);
    if (!room || !room.gameStarted) return;
    
    const ai = room.players.find(p => p.id === aiId);
    if (!ai || ai.finished) return;
    
    const aiConfigs = {
        '⚡閃電俠': { baseSpeed: 8.5, variance: 0.85, burst: 0.3 },
        '👑快打王': { baseSpeed: 7.8, variance: 0.9, burst: 0.25 },
        '🤖連點機': { baseSpeed: 7.2, variance: 0.95, burst: 0.2 },
        '💨風之子': { baseSpeed: 6.8, variance: 0.88, burst: 0.18 },
        '🎯神射手': { baseSpeed: 6.2, variance: 0.92, burst: 0.12 },
        '🐢穩健者': { baseSpeed: 5.5, variance: 0.97, burst: 0.08 },
        '🎮練習生': { baseSpeed: 4.8, variance: 0.9, burst: 0.05 }
    };
    
    const config = aiConfigs[ai.name] || { baseSpeed: 6, variance: 0.9, burst: 0.1 };
    let interval = 1000 / config.baseSpeed;
    interval *= (1 + (Math.random() - 0.5) * (1 - config.variance));
    
    if (Math.random() < config.burst) interval *= 0.5;
    
    const progress = ai.clicks / 300;
    interval *= (1 + progress * 0.4);
    
    const clicks = Math.random() < 0.1 ? 2 : 1;
    
    setTimeout(() => {
        if (!rooms.has(roomCode)) return;
        const r = rooms.get(roomCode);
        if (!r.gameStarted) return;
        
        const aiPlayer = r.players.find(p => p.id === aiId);
        if (!aiPlayer || aiPlayer.finished) return;
        
        aiPlayer.clicks += clicks;
        
        broadcastToRoom(roomCode, {
            type: 'playerClick',
            playerId: aiId,
            clicks: aiPlayer.clicks
        });
        
        if (aiPlayer.clicks >= 300) {
            aiPlayer.finished = true;
            aiPlayer.finishTime = Date.now() - r.startTime;
            
            broadcastToRoom(roomCode, {
                type: 'playerFinished',
                playerId: aiId,
                clicks: aiPlayer.clicks,
                finishTime: aiPlayer.finishTime
            });
            
            checkGameEnd(roomCode);
        } else {
            runAI(roomCode, aiId);
        }
    }, interval);
}

// 檢查遊戲結束
function checkGameEnd(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const finished = room.players.filter(p => p.finished);
    
    if (finished.length === room.players.length) {
        endGame(roomCode);
    } else if (finished.length > 0) {
        const firstTime = Math.min(...finished.map(p => p.finishTime));
        const now = Date.now() - room.startTime;
        if (now - firstTime > 5000) {
            endGame(roomCode);
        }
    }
}

// 結束遊戲
function endGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    room.gameStarted = false;
    
    const results = [...room.players].sort((a, b) => {
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.clicks - a.clicks;
    });
    
    broadcastToRoom(roomCode, {
        type: 'gameEnded',
        results: results.map((r, i) => ({
            rank: i + 1,
            id: r.id,
            name: r.name,
            avatar: r.avatar,
            isAI: r.isAI,
            clicks: r.clicks,
            finished: r.finished,
            finishTime: r.finishTime
        }))
    });
}

// 獲取玩家顏色
function getPlayerColor(index) {
    const colors = ['#2ecc71', '#e74c3c', '#3498db', '#9b59b6', '#f39c12', '#1abc9c', '#e91e63', '#00bcd4'];
    return colors[index % colors.length];
}

// 啟動伺服器
server.listen(PORT, () => {
    console.log(`🎮 祥安新春開工競賽伺服器運行中`);
    console.log(`📡 HTTP 端口: ${PORT}`);
    console.log(`🌐 WebSocket 已啟用`);
});

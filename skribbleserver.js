const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);
const PORT = 3000;

// Redis setup for pub/sub
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

// Create Redis clients with connection option set to false to prevent auto-connection
const pubClient = new Redis({ lazyConnect: true });
const subClient = pubClient.duplicate();
const dataClient = new Redis({ lazyConnect: true });

// Note: The Redis adapter ensures that all Socket.IO events (like socket.broadcast.emit,
// socket.to(roomId).emit, and io.to(roomId).emit) work seamlessly across multiple processes
// without requiring any code changes. The adapter automatically distributes events through Redis.

// Redis helper functions
async function saveUser(userId, userData) {
  await dataClient.hset(`user:${userId}`, userData);
  await dataClient.sadd('users', userId);
  if (userData.roomId) {
    await dataClient.sadd(`room:${userData.roomId}:users`, userId);
  }
  // Set TTL to prevent memory leaks if server crashes
  await dataClient.expire(`user:${userId}`, 3600); // 1 hour
}

async function getUser(userId) {
  const user = await dataClient.hgetall(`user:${userId}`);
  return Object.keys(user).length ? user : null;
}

async function deleteUser(userId) {
  const user = await getUser(userId);
  if (user && user.roomId) {
    await dataClient.srem(`room:${user.roomId}:users`, userId);
  }
  await dataClient.srem('users', userId);
  await dataClient.del(`user:${userId}`);
  return user;
}

async function saveRoom(roomId, roomData) {
  await dataClient.hset(`room:${roomId}`, roomData);
  await dataClient.sadd('rooms', roomId);
  // Set TTL to prevent memory leaks if server crashes
  await dataClient.expire(`room:${roomId}`, 7200); // 2 hours
}

async function getRoom(roomId) {
  const room = await dataClient.hgetall(`room:${roomId}`);
  return Object.keys(room).length ? room : null;
}

async function getRoomUsers(roomId) {
  const userIds = await dataClient.smembers(`room:${roomId}:users`);
  if (!userIds.length) return [];
  
  const users = await Promise.all(
    userIds.map(userId => getUser(userId))
  );
  return users.filter(Boolean); // Remove any null values
}

async function deleteRoom(roomId) {
  const userIds = await dataClient.smembers(`room:${roomId}:users`);
  // Remove room from all users
  for (const userId of userIds) {
    const user = await getUser(userId);
    if (user) {
      user.roomId = '';
      await saveUser(userId, user);
    }
  }
  
  await dataClient.del(`room:${roomId}:users`);
  await dataClient.srem('rooms', roomId);
  await dataClient.del(`room:${roomId}`);
}

async function updateUserScore(userId, points) {
  const user = await getUser(userId);
  if (!user) return null;
  
  const newScore = parseInt(user.score || 0) + points;
  await dataClient.hset(`user:${userId}`, 'score', newScore.toString());
  return newScore;
}

// In-memory storage for users (to be migrated to Redis)
const users = {};

// In-memory storage for rooms (to be migrated to Redis)
const rooms = {};

// Round duration in seconds
const ROUND_DURATION = 60;

// Words organized by categories and difficulty levels
const wordsByCategory = {
  animals: {
    easy: ['cat', 'dog', 'fish', 'bird', 'duck', 'frog', 'bear', 'lion', 'pig', 'cow'],
    medium: ['giraffe', 'elephant', 'penguin', 'monkey', 'zebra', 'rabbit', 'snake', 'tiger', 'whale', 'horse'],
    hard: ['octopus', 'rhinoceros', 'scorpion', 'jellyfish', 'chameleon', 'platypus', 'flamingo', 'hedgehog', 'armadillo', 'narwhal']
  },
  food: {
    easy: ['apple', 'banana', 'pizza', 'bread', 'cake', 'egg', 'milk', 'rice', 'soup', 'pie'],
    medium: ['hamburger', 'spaghetti', 'sandwich', 'popcorn', 'pancake', 'taco', 'sushi', 'donut', 'cupcake', 'cookie'],
    hard: ['avocado', 'croissant', 'ratatouille', 'enchilada', 'quesadilla', 'bruschetta', 'tiramisu', 'macaron', 'churros', 'baguette']
  },
  objects: {
    easy: ['chair', 'table', 'book', 'pen', 'door', 'lamp', 'key', 'hat', 'bed', 'cup'],
    medium: ['computer', 'telephone', 'umbrella', 'guitar', 'camera', 'clock', 'mirror', 'window', 'glasses', 'backpack'],
    hard: ['telescope', 'microscope', 'typewriter', 'chandelier', 'gramophone', 'kaleidoscope', 'hourglass', 'thermometer', 'compass', 'binoculars']
  },
  places: {
    easy: ['house', 'school', 'park', 'beach', 'farm', 'zoo', 'mall', 'city', 'lake', 'road'],
    medium: ['castle', 'museum', 'airport', 'library', 'hospital', 'stadium', 'mountain', 'island', 'desert', 'forest'],
    hard: ['observatory', 'lighthouse', 'cathedral', 'skyscraper', 'colosseum', 'pyramid', 'waterfall', 'volcano', 'canyon', 'archipelago']
  }
};

// Default category and difficulty
const DEFAULT_CATEGORY = 'animals';
const DEFAULT_DIFFICULTY = 'medium';

// Get a random word from the list based on category and difficulty
function getRandomWord(category = DEFAULT_CATEGORY, difficulty = DEFAULT_DIFFICULTY) {
  // Validate category and difficulty, use defaults if invalid
  if (!wordsByCategory[category]) {
    category = DEFAULT_CATEGORY;
  }
  
  if (!wordsByCategory[category][difficulty]) {
    difficulty = DEFAULT_DIFFICULTY;
  }
  
  const wordList = wordsByCategory[category][difficulty];
  return wordList[Math.floor(Math.random() * wordList.length)];
}

// Generate a hint for a word (e.g., "apple" -> "A _ _ _ _")
function generateHint(word) {
  return word.charAt(0).toUpperCase() + ' ' + '_ '.repeat(word.length - 1).trim();
}

// Start a new round in a room
async function startRound(roomId) {
  // Get room data from Redis
  let room = await getRoom(roomId);
  if (!room) {
    console.log(`Cannot start round: room ${roomId} doesn't exist in Redis`);
    return false;
  }
  
  // Fall back to in-memory room if needed during migration
  if (!room) {
    room = rooms[roomId];
  }
  
  console.log(`Attempting to start round in room ${roomId}`);
  
  // Get users in this room
  const roomUsers = await getRoomUsers(roomId);
  
  // Make sure there are at least 2 players
  if (roomUsers.length < 2) {
    console.log(`Cannot start round: room has fewer than 2 players`);
    return false;
  }
  
  console.log(`Starting round with ${roomUsers.length} players`);
  
  // Choose a random drawer if one is not already set
  let currentDrawer = room.currentDrawer;
  if (!currentDrawer) {
    const randomIndex = Math.floor(Math.random() * roomUsers.length);
    currentDrawer = roomUsers[randomIndex].id;
  }
  
  // Get a random word based on room settings
  const currentWord = getRandomWord(room.category || DEFAULT_CATEGORY, room.difficulty || DEFAULT_DIFFICULTY);
  const roundStartTime = Date.now();
  const roundEndTime = Date.now() + (ROUND_DURATION * 1000);
  
  // Save updated room data to Redis
  await saveRoom(roomId, {
    ...room,
    currentDrawer,
    currentWord,
    roundActive: 'true',
    roundStartTime: roundStartTime.toString(),
    roundEndTime: roundEndTime.toString()
  });
  
  // Update in-memory room for compatibility during migration
  if (rooms[roomId]) {
    rooms[roomId].currentDrawer = currentDrawer;
    rooms[roomId].currentWord = currentWord;
    rooms[roomId].roundActive = true;
    rooms[roomId].roundStartTime = roundStartTime;
    rooms[roomId].roundEndTime = roundEndTime;
  }
  
  // Set up timer for round end
  if (rooms[roomId] && rooms[roomId].timerInterval) {
    clearInterval(rooms[roomId].timerInterval);
    rooms[roomId].timerInterval = null;
  }
  
  // Create a timer that emits time updates every second
  const timerInterval = setInterval(async () => {
    // Get latest room data to check if round is still active
    const currentRoom = await getRoom(roomId);
    if (!currentRoom || currentRoom.roundActive !== 'true') {
      clearInterval(timerInterval);
      return;
    }
    
    const timeLeft = Math.max(0, Math.floor((parseInt(currentRoom.roundEndTime) - Date.now()) / 1000));
    
    // Send time update to all users in the room
    io.to(roomId).emit('timeUpdate', { timeLeft });
    
    // If time is up, end the round
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      
      // End the round
      io.to(roomId).emit('roundEnd', {
        word: currentRoom.currentWord,
        timeUp: true
      });
      
      // Reset room for next round
      await saveRoom(roomId, {
        ...currentRoom,
        roundActive: 'false',
        currentWord: ''
      });
      
      // Update in-memory room for compatibility
      if (rooms[roomId]) {
        rooms[roomId].roundActive = false;
        rooms[roomId].currentWord = null;
      }
      
      // Schedule next round after a short delay
      setTimeout(async () => {
        const updatedRoomUsers = await getRoomUsers(roomId);
        if (updatedRoomUsers.length >= 2) {
          // Choose a new drawer for the next round
          const users = updatedRoomUsers;
          const currentDrawerIndex = users.findIndex(u => u.id === currentRoom.currentDrawer);
          const nextDrawerIndex = (currentDrawerIndex + 1) % users.length;
          const nextDrawer = users[nextDrawerIndex].id;
          
          // Save new drawer to room
          await saveRoom(roomId, {
            ...currentRoom,
            currentDrawer: nextDrawer
          });
          
          // Update in-memory for compatibility
          if (rooms[roomId]) {
            rooms[roomId].currentDrawer = nextDrawer;
          }
          
          // Start a new round
          startRound(roomId);
        }
      }, 5000);
    }
  }, 1000);
  
  // Store timer in memory (timers can't be stored in Redis)
  if (rooms[roomId]) {
    rooms[roomId].timerInterval = timerInterval;
  }
  
  // Send word to the drawer
  const drawer = await getUser(currentDrawer);
  if (drawer) {
    io.to(currentDrawer).emit('startRound', {
      word: currentWord,
      isDrawer: true,
      duration: ROUND_DURATION,
      category: room.category || DEFAULT_CATEGORY,
      difficulty: room.difficulty || DEFAULT_DIFFICULTY
    });
  }
  
  // Send hint to other players
  const hint = generateHint(currentWord);
  for (const user of roomUsers) {
    if (user.id !== currentDrawer) {
      io.to(user.id).emit('startRound', {
        hint: hint,
        isDrawer: false,
        drawerUsername: drawer ? drawer.username : 'Unknown',
        duration: ROUND_DURATION,
        category: room.category || DEFAULT_CATEGORY,
        difficulty: room.difficulty || DEFAULT_DIFFICULTY
      });
    }
  }
  
  return true;
}

// Serve static files from the public directory
app.use(express.static('public'));

// Simple root route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected');
  
  // Send welcome message to the connected client
  socket.emit('welcome', { message: 'Welcome to Skribble!' });
  
  // Handle drawing events
  socket.on('drawing', (data) => {
    const user = users[socket.id];
    if (user && user.roomId && rooms[user.roomId]) {
      const room = rooms[user.roomId];
      
      // Only allow drawing if this user is the drawer
      if (room.currentDrawer === socket.id) {
        // Broadcast drawing to others in the room
        socket.to(user.roomId).emit('drawing', data);
      }
    }
  });
  
  // Handle clear canvas event
  socket.on('clearCanvas', () => {
    const user = users[socket.id];
    if (user && user.roomId && rooms[user.roomId]) {
      const room = rooms[user.roomId];
      
      // Only allow clearing if this user is the drawer
      if (room.currentDrawer === socket.id) {
        // Broadcast clear to others in the room
        socket.to(user.roomId).emit('clearCanvas');
      }
    }
  });
  
  // Handle chat messages and word guessing
  socket.on('chatMessage', async (data) => {
    const user = await getUser(socket.id);
    if (!user || !user.roomId) return;
    
    const roomId = user.roomId;
    const room = await getRoom(roomId);
    if (!room) return;
    
    const message = data.message.trim();
    
    // Don't allow the drawer to guess
    if (room.currentDrawer === socket.id) {
      // Just broadcast the message without checking
      io.to(roomId).emit('chatMessage', {
        userId: socket.id,
        username: user.username,
        message: message
      });
      return;
    }
    
    // Check if the message matches the current word (case insensitive)
    if (room.currentWord && message.toLowerCase() === room.currentWord.toLowerCase()) {
      console.log(`User ${user.username} guessed the word correctly: ${room.currentWord}`);
      
      // Award points: 10 to guesser, 5 to drawer
      await updateUserScore(socket.id, 10);
      console.log(`${user.username} earned 10 points for guessing correctly`);
      
      // Award points to the drawer
      if (room.currentDrawer && await getUser(room.currentDrawer)) {
        await updateUserScore(room.currentDrawer, 5);
        const drawer = await getUser(room.currentDrawer);
        console.log(`${drawer.username} earned 5 points as drawer`);
      }
      
      // Get updated scores for all users in the room
      const roomUsers = await getRoomUsers(roomId);
      const updatedScores = roomUsers.map(u => ({
        id: u.id,
        username: u.username,
        score: u.score
      }));
      
      // Emit correct guess event to all users in the room
      io.to(roomId).emit('correctGuess', {
        userId: socket.id,
        username: user.username,
        word: room.currentWord,
        scores: updatedScores
      });
      
      // End the round
      io.to(roomId).emit('roundEnd', {
        word: room.currentWord,
        scores: updatedScores
      });
      
      // Reset room for next round
      await saveRoom(roomId, {
        ...room,
        roundActive: 'false',
        currentWord: ''
      });
      
      // Clear the timer in memory
      if (rooms[roomId] && rooms[roomId].timerInterval) {
        clearInterval(rooms[roomId].timerInterval);
        rooms[roomId].timerInterval = null;
      }
      
      // Schedule next round after a short delay
      setTimeout(async () => {
        const currentRoomUsers = await getRoomUsers(roomId);
        if (currentRoomUsers.length >= 2) {
          // Choose a new drawer for the next round
          const currentDrawerIndex = currentRoomUsers.findIndex(u => u.id === room.currentDrawer);
          const nextDrawerIndex = (currentDrawerIndex + 1) % currentRoomUsers.length;
          const nextDrawer = currentRoomUsers[nextDrawerIndex].id;
          
          // Save new drawer to room
          await saveRoom(roomId, {
            ...room,
            currentDrawer: nextDrawer
          });
          
          // Start a new round
          startRound(roomId);
        }
      }, 5000);
      
      // Don't broadcast the actual message as it would reveal the word
    } else {
      // Broadcast the message to all users in the room
      io.to(roomId).emit('chatMessage', {
        userId: socket.id,
        username: user.username,
        message: message
      });
    }
  });
  
  // Handle join game event
  socket.on('joinGame', (username) => {
    console.log(`User ${username} joined the game`);
    
    // Store user info
    users[socket.id] = {
      id: socket.id,
      username: username
    };
    
    // Broadcast to all other users that someone has joined
    socket.broadcast.emit('userJoined', {
      id: socket.id,
      username: username
    });
    
    // Send the current users list to the newly connected user
    socket.emit('userList', Object.values(users));
  });
  
  // Handle room settings update
  socket.on('updateRoomSettings', (data) => {
    const user = users[socket.id];
    if (user && user.roomId && rooms[user.roomId]) {
      const room = rooms[user.roomId];
      
      // Update room settings
      if (data.category && wordsByCategory[data.category]) {
        room.category = data.category;
      }
      
      if (data.difficulty && wordsByCategory[room.category][data.difficulty]) {
        room.difficulty = data.difficulty;
      }
      
      // Broadcast updated settings to all users in the room
      io.to(user.roomId).emit('roomSettingsUpdated', {
        category: room.category,
        difficulty: room.difficulty
      });
      
      console.log(`Room ${user.roomId} settings updated: category=${room.category}, difficulty=${room.difficulty}`);
    }
  });
  
  // Handle join room event
  socket.on('joinRoom', async ({ roomId, username }) => {
    console.log(`User ${username} joined room ${roomId}`);
    
    // Create room in Redis if it doesn't exist
    let room = await getRoom(roomId);
    if (!room) {
      await saveRoom(roomId, {
        id: roomId,
        currentDrawer: '',
        currentWord: '',
        roundActive: 'false',
        category: DEFAULT_CATEGORY,
        difficulty: DEFAULT_DIFFICULTY
      });
      
      // Also create in-memory room during migration
      if (!rooms[roomId]) {
        rooms[roomId] = {
          id: roomId,
          users: [],
          currentDrawer: null,
          currentWord: null,
          roundActive: false,
          category: DEFAULT_CATEGORY,
          difficulty: DEFAULT_DIFFICULTY
        };
      }
    }
    
    // Add user to Socket.IO room
    socket.join(roomId);
    
    // Create or update user info
    const userData = {
      id: socket.id,
      username: username,
      score: '0',
      roomId: roomId
    };
    
    // Save user to Redis
    await saveUser(socket.id, userData);
    
    // Also save to in-memory store during migration
    users[socket.id] = {
      id: socket.id,
      username: username,
      score: 0,
      roomId: roomId
    };
    
    // Add user to the in-memory room during migration
    if (rooms[roomId]) {
      rooms[roomId].users.push(users[socket.id]);
    }
    
    // Get all users in this room from Redis
    const roomUsers = await getRoomUsers(roomId);
    
    // Send room info to the user
    socket.emit('roomJoined', {
      roomId: roomId,
      users: roomUsers,
      category: room ? room.category : DEFAULT_CATEGORY,
      difficulty: room ? room.difficulty : DEFAULT_DIFFICULTY,
      categories: Object.keys(wordsByCategory),
      difficulties: Object.keys(wordsByCategory[DEFAULT_CATEGORY])
    });
    
    // Broadcast to other users in the room
    socket.to(roomId).emit('userJoinedRoom', {
      user: userData
    });
    
    // Get all rooms from Redis
    const roomIds = await dataClient.smembers('rooms');
    const allRooms = await Promise.all(
      roomIds.map(async (id) => {
        const userCount = await dataClient.scard(`room:${id}:users`);
        return { id, userCount };
      })
    );
    
    // Send list of all available rooms to all connected clients
    io.emit('roomList', allRooms);
    
    // Check if we can start a round (at least 2 players)
    const roomActive = room ? room.roundActive === 'true' : false;
    if (roomUsers.length >= 2 && !roomActive) {
      console.log(`Starting round in room ${roomId} with ${roomUsers.length} players`);
      setTimeout(() => {
        startRound(roomId);
      }, 1000); // Give a short delay for UI to update
    } else {
      console.log(`Not starting round in room ${roomId}: ${roomUsers.length} players, roundActive: ${roomActive}`);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('User disconnected');
    
    // Get user info from Redis
    const user = await getUser(socket.id);
    
    if (user) {
      // Broadcast that a user has left
      socket.broadcast.emit('userLeft', {
        id: socket.id,
        username: user.username
      });
      
      // If user was in a room
      if (user.roomId) {
        const roomId = user.roomId;
        const room = await getRoom(roomId);
        
        // Broadcast to room that user left
        socket.to(roomId).emit('userLeftRoom', {
          id: socket.id,
          username: user.username
        });
        
        // Check if any users left in the room
        const roomUserIds = await dataClient.smembers(`room:${roomId}:users`);
        const roomUserCount = roomUserIds.length - 1; // Subtract 1 because we're still counting the disconnected user
        
        // If room will be empty, delete it
        if (roomUserCount <= 0) {
          // Clear any active timer in memory
          if (rooms[roomId] && rooms[roomId].timerInterval) {
            clearInterval(rooms[roomId].timerInterval);
          }
          
          // Delete room from Redis
          await deleteRoom(roomId);
          
          // Also delete from in-memory during migration
          delete rooms[roomId];
        } 
        // If the drawer left and the game is still on, choose a new drawer
        else if (room && room.currentDrawer === socket.id && room.roundActive === 'true' && roomUserCount >= 2) {
          // Get remaining users
          const remainingUsers = await getRoomUsers(roomId);
          const filteredUsers = remainingUsers.filter(u => u.id !== socket.id);
          
          if (filteredUsers.length >= 2) {
            // Choose a new random drawer
            const randomIndex = Math.floor(Math.random() * filteredUsers.length);
            const newDrawer = filteredUsers[randomIndex];
            
            // Update room with new drawer
            await saveRoom(roomId, {
              ...room,
              currentDrawer: newDrawer.id
            });
            
            // Send word to the new drawer
            io.to(newDrawer.id).emit('startRound', {
              word: room.currentWord,
              isDrawer: true,
              isNewDrawer: true
            });
            
            // Inform everyone about the new drawer
            io.to(roomId).emit('newDrawer', {
              id: newDrawer.id,
              username: newDrawer.username
            });
          }
        }
        
        // Get updated room list from Redis
        const roomIds = await dataClient.smembers('rooms');
        const rooms = await Promise.all(
          roomIds.map(async (id) => {
            const userCount = await dataClient.scard(`room:${id}:users`);
            return { id, userCount };
          })
        );
        
        // Send updated room list
        io.emit('roomList', rooms);
      }
      
      // Remove user from Redis
      await deleteUser(socket.id);
      
      // Also remove from in-memory storage during migration
      delete users[socket.id];
    }
  });
});

// Start the server after Redis is ready
async function startServer() {
  try {
    // Connect to all Redis clients
    await Promise.all([
      pubClient.connect(),
      subClient.connect(),
      dataClient.connect()
    ]);
    
    // Apply the Redis adapter
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Socket.IO connected to Redis adapter');
    
    // Add Redis client error handling
    pubClient.on('error', (err) => {
      console.error('Redis Pub Client Error:', err);
    });
    
    pubClient.on('connect', () => {
      console.log('Redis Pub Client Connected');
    });
    
    pubClient.on('reconnecting', () => {
      console.log('Redis Pub Client Reconnecting...');
    });
    
    pubClient.on('close', () => {
      console.log('Redis Pub Client Connection Closed');
    });
    
    subClient.on('error', (err) => {
      console.error('Redis Sub Client Error:', err);
    });
    
    subClient.on('connect', () => {
      console.log('Redis Sub Client Connected');
    });
    
    subClient.on('reconnecting', () => {
      console.log('Redis Sub Client Reconnecting...');
    });
    
    subClient.on('close', () => {
      console.log('Redis Sub Client Connection Closed');
    });
    
    dataClient.on('error', (err) => {
      console.error('Redis Data Client Error:', err);
    });
    
    dataClient.on('connect', () => {
      console.log('Redis Data Client Connected');
    });
    
    dataClient.on('reconnecting', () => {
      console.log('Redis Data Client Reconnecting...');
    });
    
    dataClient.on('close', () => {
      console.log('Redis Data Client Connection Closed');
    });
    
    // Start HTTP server
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
      console.log(`Access from other devices using: http://YOUR_IP_ADDRESS:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
  }
}

// Start the server
startServer(); 
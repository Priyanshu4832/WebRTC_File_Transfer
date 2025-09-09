const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require('os');

// Server configuration
const SERVER_PORT = process.env.PORT || 3000;
const SERVER_HOST = "0.0.0.0";

// CORS configuration for cross-device compatibility
const CORS_CONFIG = {
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
};

// Socket.IO configuration for better device compatibility
const SOCKET_CONFIG = {
  cors: CORS_CONFIG,
  transports: ['websocket', 'polling'], // Support devices with WebSocket issues
  pingTimeout: 60000, // Increased timeout for mobile devices
  pingInterval: 25000,
  maxHttpBufferSize: 1e8, // 100MB for large file transfers
  allowEIO3: true, // Enable Engine.IO v3 compatibility
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
};

// Initialize server
const app = express();
const server = http.createServer(app);
const io = new Server(server, SOCKET_CONFIG);

// Middleware for CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Serve static files
app.use(express.static("public"));
app.use(express.static(".")); // Serve files from current directory for development

// Data structures for managing peers
const peers = new Map(); // socket.id -> { name, pairedWith, lastSeen }

// Utility function to get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

// Broadcast available peers to all clients
function broadcastAvailablePeers() {
  const availablePeers = Array.from(peers.values())
    .filter(peer => !peer.pairedWith)
    .map(peer => peer.name);
  
  console.log(`Broadcasting available peers: [${availablePeers.join(', ')}]`);
  io.emit("available-peers", availablePeers);
}

// Clean up disconnected peers (runs every 30 seconds)
setInterval(() => {
  const now = Date.now();
  let cleaned = false;
  
  for (const [socketId, peer] of peers.entries()) {
    // Remove peers that haven't been seen for over 2 minutes
    if (now - peer.lastSeen > 120000) {
      console.log(`Cleaning up stale peer: ${peer.name}`);
      peers.delete(socketId);
      cleaned = true;
    }
  }
  
  if (cleaned) {
    broadcastAvailablePeers();
  }
}, 30000);

// Socket.IO connection handling
io.on("connection", (socket) => {
  const clientIP = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'] || 'Unknown';
  console.log(`Device connected: ${socket.id} from ${clientIP}`);
  
  // Update peer information on join
  socket.on("join", (name) => {
    // Check if name is already taken by another active connection
    const existingPeer = Array.from(peers.values()).find(peer => peer.name === name);
    if (existingPeer) {
      console.log(`Name collision: ${name} already exists, allowing duplicate`);
      // We could generate a unique name here, but for now just allow it
    }
    
    peers.set(socket.id, { 
      name, 
      pairedWith: null, 
      lastSeen: Date.now(),
      userAgent: userAgent.substring(0, 100), // Limit length
      connectedAt: Date.now()
    });
    
    console.log(`${name} joined from ${clientIP}`);
    broadcastAvailablePeers();
  });

  // Handle pairing requests
  socket.on("connect-request", ({ from, to }) => {
    console.log(`Pairing request: ${from} wants to connect to ${to}`);
    
    const fromPeer = Array.from(peers.entries()).find(([_, peer]) => peer.name === from);
    const toPeer = Array.from(peers.entries()).find(([_, peer]) => peer.name === to);

    if (!fromPeer) {
      console.log(`Pairing failed: ${from} not found`);
      socket.emit("connect-error", "Your peer session not found. Please refresh.");
      return;
    }
    
    if (!toPeer) {
      console.log(`Pairing failed: ${to} not found`);
      socket.emit("connect-error", "Target peer not found. They may have disconnected.");
      return;
    }

    if (fromPeer[1].pairedWith) {
      console.log(`Pairing failed: ${from} already paired`);
      socket.emit("connect-error", "You are already paired. Refresh to reset.");
      return;
    }
    
    if (toPeer[1].pairedWith) {
      console.log(`Pairing failed: ${to} already paired`);
      socket.emit("connect-error", `${to} is already paired with someone else.`);
      return;
    }

    // Establish pairing
    peers.get(fromPeer[0]).pairedWith = toPeer[0];
    peers.get(toPeer[0]).pairedWith = fromPeer[0];
    peers.get(fromPeer[0]).lastSeen = Date.now();
    peers.get(toPeer[0]).lastSeen = Date.now();

    // Notify both peers
    io.to(fromPeer[0]).emit("paired", to);
    io.to(toPeer[0]).emit("paired", from);
    
    console.log(`✓ Successfully paired: ${from} <-> ${to}`);
    broadcastAvailablePeers();
  });

  // Handle WebRTC signaling - make sure messages only go to paired peer
  socket.on("offer", (data) => {
    const peer = peers.get(socket.id);
    if (!peer) {
      console.log(`Offer from unknown peer: ${socket.id}`);
      return;
    }
    
    if (!peer.pairedWith) {
      console.log(`Offer from unpaired peer: ${peer.name}`);
      socket.emit("connect-error", "You are not paired with anyone.");
      return;
    }
    
    const targetPeer = peers.get(peer.pairedWith);
    if (!targetPeer) {
      console.log(`Offer target peer not found for: ${peer.name}`);
      socket.emit("connect-error", "Paired peer disconnected.");
      return;
    }
    
    console.log(`Relaying offer: ${peer.name} -> ${targetPeer.name}`);
    io.to(peer.pairedWith).emit("offer", data);
  });

  socket.on("answer", (data) => {
    const peer = peers.get(socket.id);
    if (!peer || !peer.pairedWith) {
      console.log(`Answer from invalid peer: ${peer?.name || socket.id}`);
      return;
    }
    
    const targetPeer = peers.get(peer.pairedWith);
    if (!targetPeer) {
      console.log(`Answer target peer not found for: ${peer.name}`);
      return;
    }
    
    console.log(`Relaying answer: ${peer.name} -> ${targetPeer.name}`);
    io.to(peer.pairedWith).emit("answer", data);
  });
  
  socket.on("candidate", (data) => {
    const peer = peers.get(socket.id);
    if (!peer || !peer.pairedWith) {
      // Don't log this as it's too verbose and candidates can arrive after disconnect
      return;
    }
    
    const targetPeer = peers.get(peer.pairedWith);
    if (!targetPeer) {
      return;
    }
    
    // Only log occasionally to avoid spam
    if (Math.random() < 0.1) {
      console.log(`Relaying ICE candidate: ${peer.name} -> ${targetPeer.name}`);
    }
    
    io.to(peer.pairedWith).emit("candidate", data);
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    const peer = peers.get(socket.id);
    
    if (peer) {
      console.log(`${peer.name} disconnected: ${reason}`);
      
      // Notify paired peer about disconnection
      if (peer.pairedWith) {
        const partner = peers.get(peer.pairedWith);
        if (partner) {
          partner.pairedWith = null; // Unpair the partner
          io.to(peer.pairedWith).emit("peer-disconnected", {
            name: peer.name,
            reason: reason
          });
          console.log(`Notified ${partner.name} about ${peer.name}'s disconnection`);
        }
      }
      
      peers.delete(socket.id);
      broadcastAvailablePeers();
    } else {
      console.log(`Unknown peer disconnected: ${socket.id}`);
    }
  });

  // Handle connection errors
  socket.on("error", (error) => {
    const peer = peers.get(socket.id);
    console.error(`Socket error for ${peer?.name || socket.id}:`, error.message || error);
  });

  // Heartbeat to update lastSeen
  socket.on("ping", () => {
    const peer = peers.get(socket.id);
    if (peer) {
      peer.lastSeen = Date.now();
    }
    socket.emit("pong");
  });
});

// Handle server errors
server.on('error', (error) => {
  console.error('Server error:', error);
});

// Graceful shutdown
// process.on('SIGINT', () => {
//   console.log('\nShutting down server...');
//   server.close(() => {
//     console.log('Server shut down.');
//     process.exit(0);
//   });
// });

// process.on('SIGTERM', () => {
//   console.log('\nServer terminating...');
//   server.close(() => {
//     process.exit(0);
//   });
// });

// Start the server
server.listen(SERVER_PORT, SERVER_HOST, () => {
  const ip = getLocalIpAddress();
  console.log("🚀 WebRTC Signaling Server running on:");
  console.log(`   Local:   http://localhost:${SERVER_PORT}`);
  console.log(`   Network: http://${ip}:${SERVER_PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Max connections: unlimited`);
  console.log(`   Max file size: 100MB`);
  console.log('');
});
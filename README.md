# WebRTC File Sharing + Chat (Pokémon Pairing)

A simple peer-to-peer file sharing and chat application built with **WebRTC**.  
Each browser tab is assigned a fun **Pokémon nickname**.  
You can select a peer from the dropdown, pair, and then exchange files or chat messages directly.  
The Node.js server only handles **signalling** (connection setup). File data never touches the server.


Setup

###  Install dependencies
```bash
npm init -y
npm install express socket.io

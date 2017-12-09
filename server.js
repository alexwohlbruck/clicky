var http = require('http');
var path = require('path');

var socketio = require('socket.io');
var express = require('express');
var router = express();
var server = http.createServer(router);
var io = socketio.listen(server);

router.use(express.static(path.resolve(__dirname, 'client')));

//////////////////////////////////////////////////////////////

const Clicky = require('./clicky');
// const Playlist = require('./playlist');

io.on('connection', function(socket) {
	
	socket.on('joinGame', async ({playerName}) => {
		
		const game = new Clicky();
		
		await game.join(socket);
		
		socket.emit('gameData', game);
	});

	socket.on('disconnect', function () {
		// Remove socket from sockets array
		// sockets.splice(sockets.indexOf(socket), 1);
		
		// Notify clients that player left the game
		// Update even player count status
		// if (socket.player)
		// 	io.sockets.emit('playerLeft', socket.player.id);
		// 	clicky.evenPlayerCount = sockets.map(s => s.player).filter(p => !!p).length %2 == 0;
	});

	/*socket.on('makeMove', () => {
		if (socket.player && clicky.evenPlayerCount)
			clicky.makeMove(socket.player.role);
	});*/
	
	/*socket.on('joinGame', data => {
		
		const userSocketIndex = sockets.indexOf(socket);
		
		if (sockets[userSocketIndex].player && sockets[userSocketIndex].player.id) return false;
		
		// Set role for new player
		const roles = sockets.map(s => s.player).filter(p => !!p).map(p => p.role),
			  creatorsCount   = roles.filter(role => role == 'create').length,
			  destroyersCount = roles.filter(role => role == 'destroy').length;
		
		const player = {
			id: (new Date().valueOf().toString() + Math.floor(Math.random() * 100)).substring(4, 15),
			name: data.playerName.substring(0, 20),
			role: destroyersCount - creatorsCount < 0 ? 'destroy' : 'create'
		};
		
		sockets[userSocketIndex].player = player;
		clicky.evenPlayerCount = !clicky.evenPlayerCount;
		
		socket.emit('allPlayers', {
			players: sockets.map(socket => socket.player)
							.filter(player => !!player)
							.reduce((map, obj) => {
								map[obj.id] = obj;
								return map;
							}, {}),
			playerId: player.id
		});
		socket.broadcast.emit('newPlayer', player);
	});*/
	
	socket.on('skipTrack', () => {
		clicky.soundtrack = playlist.updateTrack();
		io.sockets.emit('updateTrack', clicky.soundtrack);
	});
});

server.listen(process.env.PORT || 3000, process.env.IP || "0.0.0.0", function(){
	var addr = server.address();
	console.log("Server listening on ", addr.address + ":" + addr.port);
});

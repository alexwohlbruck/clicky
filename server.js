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
var games = [];

io.on('connection', function(socket) {
	
	socket.on('joinGame', async ({playerName}) => {
		
		var game, player;
		const newestGame = games[games.length - 1],
			  noGamesAvailable = !newestGame || newestGame.players.length > 10;
		
		if (noGamesAvailable) {
			game = new Clicky();
			player = await game.join({socket, playerName});
		
			games.push(game);
		} else {
			game = newestGame;
			player = await game.join({socket, playerName});
		}
		
		socket.gameId = game.id;
		socket.emit('gameData', {game, player});
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
		const gameId = socket.gameId,
			  game = games[gameId];
			  
		io.sockets.in(gameId).emit('updateTrack', game.playlist.tracks[game.updateTrackIndex()]);
	});
});

server.listen(process.env.PORT || 3000, process.env.IP || "0.0.0.0", function(){
	var addr = server.address();
	console.log("Server listening on ", addr.address + ":" + addr.port);
});

var http = require('http');
var path = require('path');

var socketio = require('socket.io');
var express = require('express');
var router = express();
var server = http.createServer(router);
var io = socketio.listen(server);

router.use(express.static(path.resolve(__dirname, 'client')));

const Clicky = require('./clicky');
var games = [];

io.on('connection', function(socket) {
	
	function emit(eventName, data) {
		io.sockets.in(socket.gameId).emit(eventName, data);
	}
	
	socket.on('joinGame', async ({playerName}) => {
		
		var game, player;
		const newestGame = games[games.length - 1],
			  noGamesAvailable = !newestGame || newestGame.players.length > 10;
		
		if (noGamesAvailable) {
			game = new Clicky({emit});
			player = await game.join({socket, playerName});
		
			games.push(game);
		} else {
			game = newestGame;
			player = await game.join({socket, playerName});
		}
		
		socket.emit('gameData', {game, player});
		socket.broadcast.to(socket.gameId).emit('newPlayer', player);
		
		socket.gameId = game.id;
		socket.player = player;
	});

	socket.on('disconnect', () => {
		// Remove socket from sockets array
		if (socket.gameId) {
			const game = games.find(game => game.id == socket.gameId);
			game.removePlayer(socket.id);
			io.sockets.in(socket.gameId).emit('playerLeft', socket.id);
		}
	});

	socket.on('makeMove', () => {
		if (!socket.gameId) return;
		
		const game = games.find(game => game.id == socket.gameId),
			  player = game.players.find(player => player.id == socket.id);
		
		if (socket.player && game.evenPlayerCount) {
			game.makeMove(player.role);
		}
	});
	
	socket.on('skipTrack', () => {
		const gameId = socket.gameId,
			  game = games.find(game => game.id == gameId);
			  
		if (gameId) {
			io.sockets.in(gameId).emit('updateTrack', game.playlist.tracks[game.updateTrackIndex()]);
		}
	});
});

server.listen(process.env.PORT || 3000, process.env.IP || "0.0.0.0", function(){
	var addr = server.address();
	console.log("Server listening on ", addr.address + ":" + addr.port);
});

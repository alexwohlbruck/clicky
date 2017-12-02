//
// # SimpleServer
//
// A simple chat server using Socket.IO, Express, and Async.
//
var http = require('http');
var path = require('path');

var async = require('async');
var socketio = require('socket.io');
var express = require('express');
var router = express();
var server = http.createServer(router);
var io = socketio.listen(server);

router.use(express.static(path.resolve(__dirname, 'client')));

class Clicky {
	constructor(max) {
		this.max = max || 86;
		this.stringCount = this.max / 2;
		this.evenPlayerCount = true;
	}
	makeMove(role) {
		switch (role) {
			case 'create':
				if (this.stringCount === (this.max - 1)) {
					this.gameOver({winner: 'creators'});
				} else {
					this.stringCount++;
				}
				break;
				
			case 'destroy':
				if (this.stringCount === 1) {
					this.gameOver({winner: 'destroyers'});
				} else {
					this.stringCount--;
				}
				break;
		}
		io.sockets.emit('madeMove', this.stringCount);
	}
	gameOver({winner}) {
		this.stringCount = this.max / 2;
		io.sockets.emit('gameOver', {winner, stringCount: this.stringCount});
	}
}

var clicky = new Clicky();
var sockets = [];

io.on('connection', function(socket) {
	
	socket.emit('newGame', {role: socket.role, game: clicky});
	sockets.push(socket);

	socket.on('disconnect', function () {
		sockets.splice(sockets.indexOf(socket), 1);
		
		if (socket.player)
			io.sockets.emit('playerLeft', socket.player.id);
			clicky.evenPlayerCount = !clicky.evenPlayerCount;
	});

	socket.on('makeMove', () => {
		if (socket.player/* && clicky.evenPlayerCount*/)
			clicky.makeMove(socket.player.role);
	});
	
	socket.on('joinGame', data => {
		
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
	});
});

server.listen(process.env.PORT || 3000, process.env.IP || "0.0.0.0", function(){
	var addr = server.address();
	console.log("Server listening on ", addr.address + ":" + addr.port);
});

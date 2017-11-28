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

//
// ## SimpleServer `SimpleServer(obj)`
//
// Creates a new instance of SimpleServer with the following options:
//  * `port` - The HTTP port to listen on. If `process.env.PORT` is set, _it overrides this value_.
//
var router = express();
var server = http.createServer(router);
var io = socketio.listen(server);

router.use(express.static(path.resolve(__dirname, 'client')));

class Clicky {
	constructor(max) {
		this.max = max || 100;
		this.stringCount = this.max / 2;
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
	// Set role for new player
	const roles = sockets.map(s => s.role),
		  creatorsCount   = roles.filter(role => role == 'create').length,
		  destroyersCount = roles.filter(role => role == 'destroy').length;
	
	socket.role = destroyersCount - creatorsCount < 0 ? 'destroy' : 'create';
	
	socket.emit('newGame', {role: socket.role, game: clicky});
	sockets.push(socket);

	socket.on('disconnect', function () {
		sockets.splice(sockets.indexOf(socket), 1);
	});

	socket.on('makeMove', () => {
		clicky.makeMove(socket.role);
	});
});

server.listen(process.env.PORT || 3000, process.env.IP || "0.0.0.0", function(){
	var addr = server.address();
	console.log("Server listening on ", addr.address + ":" + addr.port);
});

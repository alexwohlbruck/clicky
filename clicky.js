const spotify = require('./spotify.js');

class Clicky {
	constructor(max) {
		this.id = this.generateUniqueId();
		this.players = [];
		this.max = max || 86;
		this.stringCount = this.max / 2;
		this.evenPlayerCount = true;
		this.initialization = (async () => {
			const data = await spotify.getPlaylistTracks('alexwohlbruck', '4piPcXnIjFKrQ8qoE5ZpZ9');
			
			this.playlist = data.body.items.map(item => {
				return {
					artist: item.track.artists[0].name,
					track: item.track.name
				};
			});
		})();
	}
	
	generateUniqueId() {
		return new Date().valueOf().toString();
	}
	
	async join(socket) {
		await this.initialization;
		
		socket.join(this.id); // Add user to socket.io room
		this.players.push(socket.id); // Add user to game roster
		
		this.updateEvenPlayerCount();
	}
	
	updateEvenPlayerCount() {
		this.evenPlayerCount = !(this.players.length & 1);
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

module.exports = Clicky;
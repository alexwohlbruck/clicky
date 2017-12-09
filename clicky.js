const spotify = require('./spotify.js');

class Clicky {
	constructor(max) {
		this.id = this.generateUniqueId();
		this.players = [];
		this.max = max || 86;
		this.stringCount = this.max / 2;
		this.evenPlayerCount = true;
		this.initialization = (async () => {
			const data = await spotify.getPlaylistTracks('alexwohlbruck', '4piPcXnIjFKrQ8qoE5ZpZ9'),
				  tracks = data.body.items.map(item => {
					  return {
						  artist: item.track.artists[0].name,
						  track: item.track.name
					  };
				  });
			
			this.playlist = {
				tracks,
				index: Math.floor(Math.random() * tracks.length)
			};
		})();
	}
	
	generateUniqueId() {
		return new Date().valueOf().toString();
	}
	
	updateTrackIndex() {
		const index = Math.floor(Math.random() * this.playlist.length);
		this.playlist.index = index;
		return index;
	}
	
	async join({socket, playerName}) {
		await this.initialization; // Ensure that playlist is populated
		
		socket.join(this.id);
		
		const newPlayer = {
			id: socket.id,
			playerName,
			role: this.evenPlayerCount ? 'create' : 'destroy'
		};
		
		this.players.push(newPlayer); // Add user to game roster
		this.updateEvenPlayerCount();
		
		return newPlayer;
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
const spotify = require('./spotify.js');

class Clicky {
	constructor({emit, max}) {
		this.emit = emit;
		this.id = this.generateUniqueId();
		this.players = [];
		this.max = max || 86;
		this.roundsCount = 5;
		this.stringCount = this.max / 2;
		this.evenPlayerCount = true;
		this.score = {
			creators: 0,
			destroyers: 0
		};
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
		const index = Math.floor(Math.random() * this.playlist.tracks.length);
		this.playlist.index = index;
		return index;
	}
	
	async join({socket, playerName}) {
		await this.initialization; // Ensure that playlist is populated
		
		socket.join(this.id);
		
		const newPlayer = {
			id: socket.id,
			name: playerName,
			role: this.evenPlayerCount ? 'creators' : 'destroyers'
		};
		
		this.players.push(newPlayer); // Add user to game roster
		this.updateEvenPlayerCount();
		
		return newPlayer;
	}
	
	removePlayer(playerId) {
		const playerIndex = this.players.findIndex(player => player.id == playerId);
		
		this.players.splice(playerIndex, 1);
		this.updateEvenPlayerCount();
		
		// TODO: Delete game object if no players are left
	}
	
	updateEvenPlayerCount() {
		this.evenPlayerCount = !(this.players.length & 1);
	}
	
	makeMove(role) {
		switch (role) {
			case 'creators':
				if (this.stringCount === (this.max - 1)) {
					this.endRound({winner: 'creators'});
				} else {
					this.stringCount++;
				}
				break;
				
			case 'destroyers':
				if (this.stringCount === 1) {
					this.endRound({winner: 'destroyers'});
				} else {
					this.stringCount--;
				}
				break;
		}
		
		this.emit('madeMove', this.stringCount);
	}
	
	endRound({winner}) {
		this.score[winner]++;
		
		const scores = Object.values(this.score);
		const highestScore = Math.max(...scores);
		const highestScoreTeam = Object.keys(this.score)[scores.indexOf(highestScore)];
		
		if (highestScore >= this.roundsCount) {
			this.emit('gameOver', {winner: highestScoreTeam});
		} else {
			this.stringCount = this.max / 2;
			this.emit('roundOver', {winner});
		}
	}
}

module.exports = Clicky;
const spotify = require('./spotify');
const Promise = require('bluebird');

class Playlist {
	init() {
		return new Promise((resolve, reject) => {
			spotify.getPlaylistTracks('alexwohlbruck', '4piPcXnIjFKrQ8qoE5ZpZ9').then(tracks => {
				this.tracks = tracks.body.items.map(track => {
					return {
						track: track.track.name,
						artist: track.track.artists[0].name
					};
				});
				
				resolve();
			}, err => {
				reject(err);
			});
		});
	}
	updateTrack() {
		return this.tracks ? this.tracks[Math.floor(Math.random() * this.tracks.length)] : {};
	}
}


module.exports = Playlist;
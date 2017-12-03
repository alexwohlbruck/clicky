module.exports = {
	// https://www.randomlists.com/random-songs
	// https://codepen.io/bobhami/pen/gwAJNp
	updateTrack() {
		return this.tracks[Math.floor(Math.random() * this.tracks.length)];
	},
	tracks: [{
		track: 'girl is a queen',
		artist: 'splash'
	},{
		track: 'farrah fawcett hair',
		artist: 'capital cities'
	},{
		track: 'mr blue sky',
		artist: 'electric light orchestra'
	},{
		track: 'its tricky',
		artist: 'run'
	},{
		track: 'how i want ya',
		artist: 'hudson thames'
	},{
		track: 'champagne',
		artist: 'ganja white knight'
	},{
		track: 'takillya',
		artist: 'vinnie maniscalco'
	},{
		track: 'in cold blood baauer remix',
		artist: 'alt-j'
	},{
		track: 'ongoing thing',
		artist: '20syl'
	},{
		track: 'the wild life',
		artist: 'outasight'
	},{
		track: 'move',
		artist: 'saint motel'
	},{
		track: 'kiss this',
		artist: 'the struts'
	},{
		track: 'get ugly',
		artist: 'json derulo'
	},{
		track: 'hollow life',
		artist: 'coast modern'
	}]
};
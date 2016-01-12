'use strict';

const express = require('express');
const app = express();
const WebDriverPool = require('webdriver-pool');

const settings = require(process.env.SETTINGS_PATH);

function makePool() {
	return new WebDriverPool({
		count: settings.browserCount,
		loadImages: false
	}).ready();
}

function getPrerenderState(driver) {
	return driver.executeScript(function int() { return window.prerenderReady; });//eslint-disable-line
}

makePool()
.then(pool => {

	function onRequest(req, res, done) {
		const url = req.path.substr(1);
		console.info('rendering html for %s', url);
		pool.getDriver()
		.then(driver =>
			driver.get(url)
			.then(() => getPrerenderState(driver))
			.then(prerenderValue => {
				console.log(1, prerenderValue);
				if (prerenderValue === false) {
					return driver.wait(
						() => getPrerenderState(driver),
						settings.falseTimeout,
						'Waiting for window.prerenderReady'
					);
				}
				if (prerenderValue === undefined) {
					return driver.sleep(2000);
				}
				return true;
			})
			.then(() => driver.getPageSource())
			.then(ret => {
				pool.returnDriver(driver);
				return ret;
			}, error => {
				pool.returnDriver(driver);
				throw error;
			})
		)
		.then(code => {
			console.info('Finished generating render for %s', url);
			res.status(200).send(code).end();
			done();
		}, error => {
			console.error(error.stack);
			res.status(500).end();
			done();
		});
	}
	app.get('/*', onRequest);

	app.listen(3000, 'localhost');
});



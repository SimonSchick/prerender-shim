'use strict';

const express = require('express');
const app = express();
const WebDriverPool = require('webdriver-pool');

const browserCount = process.env.BROWSER_COUNT || 1;
const port = process.env.PORT || 3000;
const address = process.env.ADDRESS || 'localhost';
const explicitTimeout = process.env.EXPLICIT_TIMEOUT || 10000;
const implicitTimeout = process.env.IMPLICIT_TIMEOUT || 2000;

function makePool() {
	return new WebDriverPool({
		count: browserCount,
		loadImages: false,
		logging: {
			enabled: true,
			path: process.env.BROWSER_LOGGING_PATH || '/dev/null'
		}
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
				if (prerenderValue === false) {
					return driver.wait(
						() => getPrerenderState(driver),
						explicitTimeout,
						'Waiting for window.prerenderReady'
					);
				}
				if (prerenderValue === undefined) {
					return driver.sleep(implicitTimeout);
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

	app.listen(port, address);
});



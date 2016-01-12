'use strict';

const express = require('express');
const WebDriverPool = require('webdriver-pool');
const Cache = require('node-cache');

const browserCount = process.env.BROWSER_COUNT || 1;
const port = process.env.PORT || 3000;
const address = process.env.ADDRESS || 'localhost';
const explicitTimeout = process.env.EXPLICIT_TIMEOUT || 10000;
const implicitTimeout = process.env.IMPLICIT_TIMEOUT || 2000;
const cacheTTL = process.env.CACHE_TTL || 300;

function makePool() {
	return new WebDriverPool({
		count: browserCount,
		loadImages: false,
		logging: {
			enabled: true,
			path: process.env.BROWSER_LOGGING_PATH || '/dev/null'
		},
		userAgent: 'Prerender'
	}).ready();
}

function getPrerenderState(driver) {
	return driver.executeScript(function int() { return window.prerenderReady; });//eslint-disable-line
}

const app = express();
app.disable('etag');

makePool()
.then(pool => {

	const cache = new Cache({
		stdTTL: cacheTTL,
		checkperiod: 10
	});

	function onRequest(req, res, done) {
		const url = decodeURIComponent(req.path.substr(1));
		const cached = cache.get(url);
		if (cached) {
			console.info('Returning cache for %s ', url);
			res.status(200).send(cached).end();
			done();
			return;
		}
		console.info('rendering html for %s', url);
		let driver;
		let pageSource;
		let isPresent;
		pool.getDriver()
		.then(driv => {
			driver = driv;
			driver.get(url);
		})
		.then(() => getPrerenderState(driver))
		.then(prerenderValue => { //check prerender state
			if (prerenderValue === false) {
				return driver.wait(
					() => getPrerenderState(driver),
					explicitTimeout,
					'Waiting for window.prerenderReady'
				)
				.thenCatch(() => { /* do nothing, just stop the error */ });
			}
			if (prerenderValue === undefined) {
				return driver.sleep(implicitTimeout);
			}
			return true;
		})
		.then(() => driver.getPageSource()) //fetch source
		.then(source => {
			pageSource = source;
			return driver.isElementPresent({ //make sure the page is valid
				css: 'meta[name=fragment]'
			});
		})
		.then(present => {
			isPresent = present;
			pool.returnDriver(driver);
		}, error => {
			pool.returnDriver(driver);
			throw error;
		})
		.then(() => {
			console.info('Finished generating render for %s', url);
			if (isPresent === false) {
				console.info('But will not cache because success condition failed');
			} else {
				cache.set(url, pageSource);
			}
			res.status(200).send(pageSource).end();
		})
		.catch(error => {
			console.error(error.stack);
			res.status(500).end();
		})
		.finally(done);
	}
	app.get('/*', onRequest);

	app.listen(port, address);
});



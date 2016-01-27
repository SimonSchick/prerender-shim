'use strict';

const express = require('express');
const WebDriverPool = require('webdriver-pool');
const Cache = require('node-cache');
const promiseRetry = require('promise-retry');



class PrerenderServer {
	constructor(config) {
		this.config = config;
	}

	createPool() {
		const config = this.config;
		this.pool = new WebDriverPool({
			count: config.poolSize,
			loadImages: false,
			logging: {
				enabled: true,
				path: config.driverLogPath
			},
			userAgent: 'Prerender'
		});
		this.pool.on('warn', warning => {
			console.warn(warning.message);
			if (warning.error) {
				console.warn(warning.error.stack);
			}
		});
		return this.pool.ready();
	}

	makeHTTPServer() {
		this.app = express();
		this.app.disable('etag');
		this.app.get('/*', (req, res, done) => {
			this.handleRequest(req, res)
			.then(data => {
				res.status(200).end(data);
				done();
			}, error => {
				console.error(error.stack);
				res.status(500).end();
				done();
			});
		});
		return new Promise((resolve, reject) => {
			this.app.listen(this.config.port, this.config.address, error => {
				if (error) {
					return reject(error);
				}
				return resolve();
			});
		});
	}

	getPrerenderState(driver) {
		return driver.executeScript(function int() { //eslint-disable-line prefer-arrow-callback
			return window.prerenderReady; //eslint-disable-line no-undef
		});
	}

	driverRun(url) {
		let driver;
		const pool = this.pool;
		const config = this.config;
		return pool.getDriver()
		.then(driv => {
			driver = driv;
			driver.get(url);
		})
		.then(() => this.getPrerenderState(driver))
		.then(prerenderValue => { //check prerender state
			if (prerenderValue === false) {
				return driver.wait(
					() => this.getPrerenderState(driver),
					config.explicitTimeout,
					'Waiting for window.prerenderReady'
				)
				.catch(() => { /* do nothing, just stop the error */ });
			}
			if (prerenderValue === undefined) {
				return driver.sleep(config.implicitTimeout);
			}
			return true;
		})
		.then(() => driver.isElementPresent({ //make sure the page is valid
			css: 'meta[name=fragment]'
		})
		)
		.then(pageOk =>
			driver.getPageSource()
			.then(source => ({
				pageOk,
				source
			}))
		)
		.then(info => pool.returnDriver(driver).then(() => info))
		.timeout(config.renderTimeout)
		.catch(error => {
			if (error.code === 'ECONNREFUSED') {
				return pool.returnDriver(driver)
				.then(() => { //trigger the retry
					console.warn('Driver was unresponse and has been renewed');
					throw error;
				});
			}
			return pool.returnDriver(driver)
			.then(() => {
				throw error;
			});
		});
	}

	handleRequest(req) {
		const url = decodeURIComponent(req.path.substr(1));
		const cached = this.cache.get(url);
		if (cached) {
			console.info('Returning cache for %s ', url);
			return Promise.resolve(cached);
		}
		console.info('Rendering html for %s...', url);
		return promiseRetry(retry => this.driverRun(url).catch(retry), {
			retries: this.config.maxRetries
		})
		.then(pageInfo => {
			console.info('Finished generating render for %s', url);
			if (pageInfo.pageOk) {
				this.cache.set(url, pageInfo.source);
			} else {
				console.info('But will not cache because success condition a');
			}
			return pageInfo.source;
		});
	}

	makeCache() {
		this.cache = new Cache({
			stdTTL: this.config.cacheTTL,
			checkperiod: 10
		});
	}

	start() {
		this.makeCache();
		return this.createPool()
		.then(() => this.makeHTTPServer());
	}
}

const server = new PrerenderServer({
	poolSize: process.env.BROWSER_COUNT || 1,
	port: process.env.PORT || 3000,
	address: process.env.ADDRESS || 'localhost',
	explicitTimeout: process.env.EXPLICIT_TIMEOUT || 10000,
	implicitTimeout: process.env.IMPLICIT_TIMEOUT || 2000,
	cacheTTL: process.env.CACHE_TTL || 300,
	driverLogPath: process.env.BROWSER_LOGGING_PATH || '/dev/null',
	maxRetries: process.env.MAX_RETRIES || 2,
	renderTimeout: process.env.RENDER_TIMEOUT || 20000
});
server.start()
.then(() => {
	console.info('Running');
}, error => {
	console.error('Failed to start', error.stack);
});

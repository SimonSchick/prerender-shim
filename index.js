'use strict';

const express = require('express');
const WebDriverPool = require('webdriver-pool');
const Cache = require('node-cache');
const promiseRetry = require('promise-retry');
const url = require('url');

/**
 * Prerender server class.
 */
class PrerenderServer {

	/**
	 * @param  {Object} config The config options.
	 */
	constructor(config) {
		this.config = config;
	}

	/**
	 * Creates the webdriver pool
	 * @private
	 * @return {Promise.<WebDriverPool>} Resolves the created pool.
	 */
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

	/**
	 * Creates the http server.
	 * @private
	 * @return {Promise} Resolves once the server is listening.
	 */
	makeHTTPServer() {
		this.app = express();
		this.app.disable('etag');
		this.app.get('/*', (req, res, done) => {
			this.handleRequest(req, res)
			.then(data => {
				res.set('Content-Type', 'text/html');
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

	/**
	 * [getPrerenderState description]
	 * @private
	 * @param  {WebDriver} driver The driver to get the state from.
	 * @return {Promise.<!boolean>} Resolves the pages prerender state.
	 */
	getPrerenderState(driver) {
		return driver.executeScript(function int() { //eslint-disable-line prefer-arrow-callback
			return window.prerenderReady; //eslint-disable-line no-undef
		});
	}

	/**
	 * Runs the actual rendering process.
	 * Times out after renderTimeout
	 * @private
	 * @param  {string} url The url of the page to load.
	 * @return {Promise.<{pageOk: boolean, source: string}>} Resolves an object containing
	 * pageOk indicating if the page was valid for prerendering and source which is the actual DOMs html
	 */
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
				.catch(() => { console.log('Explicit timeout, render did not finish'); });
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

	/**
	 * Main request handler for all incomign requests.
	 * @private
	 * @param  {http.Request} req The incoming request.
	 * @return {Promise.<string>} Resolves the response text.
	 */
	handleRequest(req) {
		const rawUrl = decodeURIComponent(req.path.substr(1));
		const parsed = url.parse(rawUrl);
		if (!parsed.protocol || !parsed.protocol.match(/^https?:$/i) || !parsed.host) {
			return Promise.resolve('INVALID URL');
		}

		const cached = this.cache.get(rawUrl);
		if (cached) {
			console.info('Returning cache for %s ', rawUrl);
			return Promise.resolve(cached);
		}
		console.info('Rendering html for %s...', rawUrl);
		return promiseRetry(retry => this.driverRun(rawUrl).catch(retry), {
			retries: this.config.maxRetries
		})
		.then(pageInfo => {
			console.info('Finished generating render for %s', rawUrl);
			if (pageInfo.pageOk) {
				this.cache.set(rawUrl, pageInfo.source);
			} else {
				console.info('But will not cache because success condition failed.');
			}
			return pageInfo.source;
		});
	}

	/**
	 * Creates the cache used for chaching html renders.
	 * @private
	 */
	makeCache() {
		this.cache = new Cache({
			stdTTL: this.config.cacheTTL,
			checkperiod: 10
		});
	}

	/**
	 * Starts the actual server.
	 * @return {Promise} Resolves once the webdriver pool and web server have been created.
	 */
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

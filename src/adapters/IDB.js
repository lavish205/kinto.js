"use strict";

import BaseAdapter from "./base.js";
import { reduceRecords } from "../utils";

const INDEXED_FIELDS = ["id", "_status", "last_modified"];


/**
 * IDB cursor handlers.
 * @type {Object}
 */
const cursorHandlers = {
  all(done) {
    const results = [];
    return function(event) {
      const cursor = event.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        done(results);
      }
    };
  },

  in(values, done) {
    const sortedValues = [].slice.call(values).sort();
    const results = [];
    return function(event) {
      const cursor = event.target.result;
      if (!cursor) {
        done(results);
        return;
      }
      const {key, value} = cursor;
      let i = 0;
      while (key > sortedValues[i]) {
        // The cursor has passed beyond this key. Check next.
        ++i;
        if (i === sortedValues.length) {
          done(results); // There is no next. Stop searching.
          return;
        }
      }
      if (key === sortedValues[i]) {
        results.push(value);
        cursor.continue();
      } else {
        cursor.continue(sortedValues[i]);
      }
    };
  }
};

/**
 * Extract from filters definition the first indexed field. Since indexes were
 * created on single-columns, extracting a single one makes sense.
 *
 * @param  {Object} filters The filters object.
 * @return {String|undefined}
 */
function findIndexedField(filters) {
  const filteredFields = Object.keys(filters);
  const indexedFields = filteredFields.filter(field => {
    return INDEXED_FIELDS.indexOf(field) !== -1;
  });
  return indexedFields[0];
}

/**
 * Creates an IDB request and attach it the appropriate cursor event handler to
 * perform a list query.
 *
 * Multiple matching values are handled by passing an array.
 *
 * @param  {IDBStore}         store      The IDB store.
 * @param  {String|undefined} indexField The indexed field to query, if any.
 * @param  {Any}              value      The value to filter, if any.
 * @param  {Function}         done       The operation completion handler.
 * @return {IDBRequest}
 */
function createListRequest(store, indexField, value, done) {
  if (!indexField) {
    // Get all records.
    const request = store.openCursor();
    request.onsuccess = cursorHandlers.all(done);
    return request;
  }

  // WHERE IN equivalent clause
  if (Array.isArray(value)) {
    const request = store.index(indexField).openCursor();
    request.onsuccess = cursorHandlers.in(value, done);
    return request;
  }

  // WHERE field = value clause
  const request = store.index(indexField).openCursor(IDBKeyRange.only(value));
  request.onsuccess = cursorHandlers.all(done);
  return request;
}

/**
 * IndexedDB adapter.
 */
export default class IDB extends BaseAdapter {
  /**
   * Constructor.
   *
   * @param  {String} dbname The database nale.
   */
  constructor(dbname) {
    super();
    this._db = null;
    // public properties
    /**
     * The database name.
     * @type {String}
     */
    this.dbname = dbname;
  }

  _handleError(method) {
    return err => {
      const error = new Error(method + "() " + err.message);
      error.stack = err.stack;
      throw error;
    };
  }

  /**
   * Ensures a connection to the IndexedDB database has been opened.
   *
   * @override
   * @return {Promise}
   */
  open() {
    if (this._db) {
      return Promise.resolve(this);
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbname, 1);
      request.onupgradeneeded = event => {
        // DB object
        const db = event.target.result;
        // Main collection store
        const collStore = db.createObjectStore(this.dbname, {
          keyPath: "id"
        });
        // Primary key (generated by IdSchema, UUID by default)
        collStore.createIndex("id", "id", { unique: true });
        // Local record status ("synced", "created", "updated", "deleted")
        collStore.createIndex("_status", "_status");
        // Last modified field
        collStore.createIndex("last_modified", "last_modified");

        // Metadata store
        const metaStore = db.createObjectStore("__meta__", {
          keyPath: "name"
        });
        metaStore.createIndex("name", "name", { unique: true });
      };
      request.onerror = event => reject(event.target.error);
      request.onsuccess = event => {
        this._db = event.target.result;
        resolve(this);
      };
    });
  }

  /**
   * Closes current connection to the database.
   *
   * @override
   * @return {Promise}
   */
  close() {
    if (this._db) {
      this._db.close(); // indexedDB.close is synchronous
      this._db = null;
    }
    return super.close();
  }

  /**
   * Returns a transaction and a store objects for this collection.
   *
   * To determine if a transaction has completed successfully, we should rather
   * listen to the transaction’s complete event rather than the IDBObjectStore
   * request’s success event, because the transaction may still fail after the
   * success event fires.
   *
   * @param  {String}      mode  Transaction mode ("readwrite" or undefined)
   * @param  {String|null} name  Store name (defaults to coll name)
   * @return {Object}
   */
  prepare(mode=undefined, name=null) {
    const storeName = name || this.dbname;
    // On Safari, calling IDBDatabase.transaction with mode == undefined raises
    // a TypeError.
    const transaction = mode ? this._db.transaction([storeName], mode)
                             : this._db.transaction([storeName]);
    const store = transaction.objectStore(storeName);
    return {transaction, store};
  }

  /**
   * Deletes every records in the current collection.
   *
   * @override
   * @return {Promise}
   */
  clear() {
    return this.open().then(() => {
      return new Promise((resolve, reject) => {
        const {transaction, store} = this.prepare("readwrite");
        store.clear();
        transaction.onerror = event => reject(new Error(event.target.error));
        transaction.oncomplete = () => resolve();
      });
    }).catch(this._handleError("clear"));
  }

  /**
   * Executes the set of synchronous CRUD operations described in the provided
   * callback within an IndexedDB transaction, for current db store.
   *
   * The callback will be provided an object exposing the following synchronous
   * CRUD operation methods: get, create, update, delete.
   *
   * Important note: because limitations in IndexedDB implementations, no
   * asynchronous code should be performed within the provided callback; the
   * promise will therefore be rejected if the callback returns a Promise.
   *
   * Options:
   * - {Array} preload: The list of record IDs to fetch and make available to
   *   the transaction object get() method (default: [])
   *
   * @example
   * const db = new IDB("example");
   * db.execute(transaction => {
   *   transaction.create({id: 1, title: "foo"});
   *   transaction.update({id: 2, title: "bar"});
   *   transaction.delete(3);
   *   return "foo";
   * })
   *   .catch(console.error.bind(console));
   *   .then(console.log.bind(console)); // => "foo"
   *
   * @param  {Function} callback The operation description callback.
   * @param  {Object}   options  The options object.
   * @return {Promise}
   */
  execute(callback, options={preload: []}) {
    // Transactions in IndexedDB are autocommited when a callback does not
    // perform any additional operation.
    // The way Promises are implemented in Firefox (see https://bugzilla.mozilla.org/show_bug.cgi?id=1193394)
    // prevents using within an opened transaction.
    // To avoid managing asynchronocity in the specified `callback`, we preload
    // a list of record in order to execute the `callback` synchronously.
    // See also:
    // - http://stackoverflow.com/a/28388805/330911
    // - http://stackoverflow.com/a/10405196
    // - https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/
    return this.open()
      .then(_ => new Promise((resolve, reject) => {
        // Start transaction.
        const {transaction, store} = this.prepare("readwrite");
        // Preload specified records using index.
        const ids = options.preload;
        store.index("id").openCursor().onsuccess = cursorHandlers.in(ids, (records) => {
          // Store obtained records by id.
          const preloaded = records.reduce((acc, record) => {
            acc[record.id] = record;
            return acc;
          }, {});
          // Expose a consistent API for every adapter instead of raw store methods.
          const proxy = transactionProxy(store, preloaded);
          // The callback is executed synchronously within the same transaction.
          let result;
          try {
            result = callback(proxy);
          } catch (e) {
            transaction.abort();
            reject(e);
          }
          if (result instanceof Promise) {
            // XXX: investigate how to provide documentation details in error.
            reject(new Error("execute() callback should not return a Promise."));
          }
          // XXX unsure if we should manually abort the transaction on error
          transaction.onerror = event => reject(new Error(event.target.error));
          transaction.oncomplete = event => resolve(result);
        });
      }));
  }

  /**
   * Retrieve a record by its primary key from the IndexedDB database.
   *
   * @override
   * @param  {String} id The record id.
   * @return {Promise}
   */
  get(id) {
    return this.open().then(() => {
      return new Promise((resolve, reject) => {
        const {transaction, store} = this.prepare();
        const request = store.get(id);
        transaction.onerror = event => reject(new Error(event.target.error));
        transaction.oncomplete = () => resolve(request.result);
      });
    }).catch(this._handleError("get"));
  }

  /**
   * Lists all records from the IndexedDB database.
   *
   * @override
   * @return {Promise}
   */
  list(params={filters: {}}) {
    const {filters} = params;
    const indexField = findIndexedField(filters);
    const value = filters[indexField];
    return this.open().then(() => {
      return new Promise((resolve, reject) => {
        let results = [];
        const {transaction, store} = this.prepare();
        createListRequest(store, indexField, value, (_results) => {
          // we have received all requested records, parking them within
          // current scope
          results = _results;
        });
        transaction.onerror = event => reject(new Error(event.target.error));
        transaction.oncomplete = event => resolve(results);
      });
    })
    .then((results) => {
      // The resulting list of records is filtered and sorted.
      const remainingFilters = {...filters};
      // If `indexField` was used already, don't filter again.
      delete remainingFilters[indexField];
      // XXX: with some efforts, this could be fully implemented using IDB API.
      return reduceRecords(remainingFilters, params.order, results);
    })
    .catch(this._handleError("list"));
  }

  /**
   * Store the lastModified value into metadata store.
   *
   * @override
   * @param  {Number}  lastModified
   * @return {Promise}
   */
  saveLastModified(lastModified) {
    const value = parseInt(lastModified, 10) || null;
    return this.open().then(() => {
      return new Promise((resolve, reject) => {
        const {transaction, store} = this.prepare("readwrite", "__meta__");
        store.put({name: "lastModified", value: value});
        transaction.onerror = event => reject(event.target.error);
        transaction.oncomplete = event => resolve(value);
      });
    });
  }

  /**
   * Retrieve saved lastModified value.
   *
   * @override
   * @return {Promise}
   */
  getLastModified() {
    return this.open().then(() => {
      return new Promise((resolve, reject) => {
        const {transaction, store} = this.prepare(undefined, "__meta__");
        const request = store.get("lastModified");
        transaction.onerror = event => reject(event.target.error);
        transaction.oncomplete = event => {
          resolve(request.result && request.result.value || null);
        };
      });
    });
  }

  /**
   * Load a dump of records exported from a server.
   *
   * @abstract
   * @return {Promise}
   */
  loadDump(records) {
    return this.execute((transaction) => {
      records.forEach(record => transaction.update(record));
    })
      .then(() => this.getLastModified())
      .then((previousLastModified) => {
        const lastModified = Math.max(...records.map(record => record.last_modified));
        if (lastModified > previousLastModified) {
          return this.saveLastModified(lastModified);
        }
      })
      .then(() => records)
      .catch(this._handleError("loadDump"));
  }
}


/**
 * IDB transaction proxy.
 *
 * @param  {IDBStore} store     The IndexedDB database store.
 * @param  {Array}    preloaded The list of records to make available to
 *                              get() (default: []).
 * @return {Object}
 */
function transactionProxy(store, preloaded = []) {
  return {
    create(record) {
      store.add(record);
    },

    update(record) {
      store.put(record);
    },

    delete(id) {
      store.delete(id);
    },

    get(id) {
      return preloaded[id];
    },
  };
}

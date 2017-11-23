'use strict';

var fs = require('fs');
var tgz = require('tar.gz');
var mkdirp = require('mkdirp');
var Path = require('path');
var glob = require('glob');
var async = require('async');
var rimraf = require('rimraf');
var _ = require('underscore');

var log = function () {
  console.log.apply(console, arguments);
};

var error = function () {
  console.error.apply(console, arguments);
};

// resolve the given path relative to the base dir, looks in all parent dirs until path is found
var resolvePath = function (base, path, callback) {
  parentDirs(base, function (err, parentDirs) {
    if (err) {
      callback(err);
      return;
    }
    function checkExists(dir) {
      if (dir === undefined) {
        callback('file not found');
        return;
      }

      var fullPath = Path.join(dir, path);
      fs.access(fullPath, fs.constants.R_OK, function (err) {
        if (err) {
          checkExists(parentDirs.shift());
        } else {
          callback(null, fullPath);
        }
      })
    }
    checkExists(parentDirs.shift());

  });
};

// get a list of all parent dirs including and starting from base
var parentDirs = function (base, callback) {
  var result = [base];
  var dir = base;
  var newDir = Path.dirname(dir);
  while (dir !== newDir) {
    result.push(newDir);
    dir = newDir;
    newDir = Path.dirname(dir);
  }
  callback(null, result);
};

function NpmStrategy(options) {
  this.mode = options.mode || 'develop';
  this.verbose = options.verbose || false;
  this.cwd = options.cwd || process.cwd();
  this.modulePath = Path.join(this.cwd, '.modules');
  this.nodeModulesPath = Path.join(this.cwd, 'node_modules');

  var pkgjson = require(Path.join(this.cwd, 'package.json'));
  this.dependencies = pkgjson.dependencies;
  this.devDependencies = pkgjson.devDependencies;
  this.optionalDependencies = pkgjson.optionalDependencies || {};
  this.allDependencies = _.extend({}, this.dependencies, this.devDependencies, this.optionalDependencies);
}

NpmStrategy.prototype._install = function (type, destPath, callback) {
  var deps;
  if (type === '*') {
    deps = this.allDependencies;
  } else {
    deps = this[type];
  }
  var sep = '-v';
  var self = this;
  async.eachSeries(glob.sync('**/*.tgz', {
    cwd: this.modulePath
  }), function (file, cb) {
    var archive = Path.join(self.modulePath, file);
    file = file.replace(/\.tgz$/i, '');
    var name = file.substring(0, file.lastIndexOf(sep));
    var version = file.substring(file.lastIndexOf(sep) + sep.length);

    if (deps[name]) {
      // remove existing installed module
      var outDir = Path.join(destPath, name);
      var outParent = Path.dirname(outDir);
      rimraf.sync(outDir);

      // extract the module into node_modules
      new tgz().extract(archive, outParent, function (err) {
        if (!err) {
          log('Extracted', name + '@' + version);
        } else {
          error(err);
        }
        cb();
      });
    } else {
      cb();
    }
  }, function () {
    log('\nDone! Now run \'npm rebuild\'');
    if (callback) {
      callback();
    }
  });
};

NpmStrategy.prototype._pack = function (name, version, callback) {
  var sep = '-v';
  var self = this;

  log('Packing', name + sep + version);

  resolvePath(this.cwd, Path.join('node_modules', name), function (err, source) {
    if (err) {
      callback(err);
      return;
    }

    var dest = Path.join(self.modulePath, name + sep + version + '.tgz');

    new tgz().compress(source, dest, function (err) {
      if (err) {
        error('Failed to pack', name);
      } else {
        log('Packed', name);
      }
      if (callback) {
        callback();
      }
    });
  });
};

NpmStrategy.prototype._packAll = function (srcList, curInst, callback) {
  var self = this;
  var sep = '-v';

  // retrieve all packed dependencies
  var curMods = glob.sync('*.tgz', {
    cwd: this.modulePath
  }).reduce(function (memo, file) {
    file = file.replace(/\.tgz$/i, '');
    var name = file.substring(0, file.lastIndexOf(sep));
    var version = file.substring(file.lastIndexOf(sep) + sep.length);
    memo[name] = version;
    return memo;
  }, {});

  // log any packed modules that are not in the source list
  _.difference(Object.keys(curMods), Object.keys(srcList)).forEach(function (name) {
    var fv = name + sep + curMods[name];
    if (self.verbose) {
      log('Module ', fv, 'is not specified in the package.json');
    }
  });

  // warn about missing deps
  _.difference(Object.keys(srcList), Object.keys(curInst)).forEach(function (name) {
    error('WARNING:', name, 'is not installed!');
  });

  // Update any dependencies that have different versions
  // and pack any that are missing completely
  async.eachSeries(Object.keys(curInst), function (name, cb) {
    if (!srcList[name]) {
      return cb();
    }
    if (curInst[name] === curMods[name]) {
      return cb();
    }
    if (!curMods[name]) {
      log('Adding', name + sep + curInst[name]);
    }
    if (curMods[name] && curInst[name] !== curMods[name]) {
      log('Module', name, 'has changed from ', curMods[name], 'to', curInst[name]);
      fs.unlinkSync(Path.join(self.modulePath, name + sep + curMods[name] + '.tgz'));
    }
    return self._pack(name, curInst[name], cb);
  }, function () {
    if (callback) {
      callback();
    }
  });
};

NpmStrategy.prototype.install = function (callback) {
  // ensure that the relevant directory exists
  mkdirp.sync(this.nodeModulesPath);

  if (this.mode === 'production') {
    log('Installing production modules');
    this._install('dependencies', this.nodeModulesPath, callback);
  } else {
    log('Installing all modules');
    this._install('*', this.nodeModulesPath, callback);
  }
};

NpmStrategy.prototype.pack = function (target, callback) {
  var self = this;
  var sep = '-v';

  if (target && !callback) {
    if (_.isFunction(target)) {
      callback = target;
      target = null;
    }
  }

  if (target && !this.allDependencies[target]) {
    error(target + ' doesn\'t exist');
    process.exit(1);
  } else if (target && this.allDependencies[target]) {
    var name = target;
    resolvePath(this.cwd, Path.join('node_modules', name, 'package.json'), function (err, file) {
      if (err) {
        error(err);
        process.exit(1);
      }
      log('Adding', name + sep + file.version);
      self._pack(name, version, callback);
    });
  } else {
    // get a list of all currently installed node_modules
    parentDirs(this.cwd, function (err, parents) {
      if (err) {
        error(err);
        process.exit(1);
      }
      var parentNodeModulesPaths = parents.map(function (dir) {return Path.resolve(dir, 'node_modules')});
      var moduleNames = parentNodeModulesPaths.map(function (nodeModules) {
        return glob.sync('*', {cwd: nodeModules})
            .filter(function (i) { return !i.startsWith('@');})
            .concat(glob.sync('@*/*', {cwd: nodeModules}))})
      // flatten the [[,],[,]] => [,,,]
          .reduce(function (all, arr) {return all.concat(arr);}, []);
      var curInst = {};
      async.eachSeries(moduleNames, function(moduleName, done) {
        resolvePath(self.cwd, Path.join('node_modules', moduleName, 'package.json'), function (err, packagePath) {
          if (err) {
            error(err);
            process.exit(1);
          }
          fs.readFile(packagePath, function (err, content) {
            if (err) {
              done(err);
              return;
            }
            var pkg = JSON.parse(content);
            curInst[moduleName] = pkg.version || '*'; // if version is not found, use *
            done();
          });
        })
      }, function (err) {
        if (err) {
          error(err);
          process.exit(1);
        }
        if (self.mode === 'production') {
          self._packAll(self.dependencies, curInst, callback);
        } else {
          self._packAll(self.allDependencies, curInst, callback);
        }
      });
    });
  }
};

module.exports = NpmStrategy;

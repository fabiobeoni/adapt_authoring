/**
 * Adapt Builder back-end output plugin to support inclusion of
 * HTML5 based animations as course contents.
 * This plugin extends the Assets library import feature
 * by automatically unpacking Adobe Animate CC files (OAM)
 * uploaded as asset. In this way, the unpacked content
 * can be referenced in the course by using the "Animation Frame"
 * custom component.
 * The plugin also supports and unpacks any other ZIP file
 * hosting a root directory and an entry point "index.html"
 * file. The ZIP must be renamed to OAM to be compliant.
 * @see https://github.com/fabiobeoni/adapt-animation-frame
 * @author Fabio Beoni: https://github.com/fabiobeoni
 */

var path = require('path');
var fsmonitor = require('fsmonitor');
var fs = require('fs');
var fsextra = require('fs-extra');
var decompress = require('decompress');
var FileHound = require('filehound');
var logger = require('../../../lib/logger');
var config = require('./config.json');


// path to the directory where Adapt AT builds
// the course output for previewing
// TODO: periodically review this path on new AT releases to
// make sure to target the right output directory
var WATCHING_DIR = path.join(__dirname + config.previewOutputDirectoryPath);

var ERROR_UNPACKING = 'Error decompressing OAM/ZIP package';
var ERROR_MISSING_ENTRY_POINT = 'Missing animation entry point "index.html" in package ';
var ERROR_EMPTY_PACKAGE = 'Empty package ';
var INFO_INIT = 'Initializing "AnimationAssetUnpack" backend plugin.';
var INFO_UNPACKING = 'Unpacking OAM/ZIP ';
var ENTRY_FILE = 'index.html';

// Needed by the plugin architecture or Adapt
function AnimationAssetUnpack() {

}

// defines the public interface
// of the plugin
var pluginInstance = {
  /**
   * Looks into the given directory
   * to find OAM/ZIP packages and decompress
   * them is any is available.
   * @param dir {string}
   * @param onProcessDirDone {function}: (err,files)
   */
  processDir: function(dir, onProcessDirDone) {
    FileHound.create()
      .paths(dir)
      .ext(['oam'])
      .find(function onFilesFound(err, packageFiles) {
        if (err) {
          return onProcessDirDone(err, null);
        }
        if (packageFiles.length > 0) {
          pluginInstance.unpack(packageFiles, function onUnpackCompleted(err, files) {
            return onProcessDirDone(err, files);
          });
        }
        else {
          return onProcessDirDone(null, null);
        }
      });
  },

  /**
   * Unpacks all given OAM/ZIP files
   * into the course assets dir.
   * @param packageFiles {string[]}
   * @param onUnpackDone {function} (err,files)
   */
  unpack: function(packageFiles, onUnpackDone) {
    var unpackedCount = 0;
    var total = packageFiles.length;

    for (var i in packageFiles) {
      (function loopPackages() {
        var packageFileName = packageFiles[i];

        logger.log('info',INFO_UNPACKING + packageFileName);

        var packageName = path.basename(packageFileName).replace(path.extname(packageFileName), '');
        var packageDir = path.join(path.dirname(packageFileName), packageName);

        // makes a dir with the name of
        // the OAM/ZIP package and decompress
        // contents into it
        fsextra.ensureDirSync(packageDir);

        decompress(packageFileName, packageDir)
          .then(function onDecompressed(filesFromPackage) {

            validatePackage(packageDir, filesFromPackage,
              function onValidationDone(err) {
                if(!err) {
                  // removes redundant root folder from
                  // the OAM package file
                  removePackageRoot(packageDir, filesFromPackage);

                  // removes the oam package, not
                  // needed in exported course
                  fsextra.removeSync(packageFileName);

                  unpackedCount++;

                  if (unpackedCount === total) {
                    onUnpackDone(null, filesFromPackage);
                  }
                }
                else {
                  logger.log('error', ERROR_UNPACKING, err);
                  onUnpackDone(err, null);
                }
              });

          })
          .catch(function(err) {
            logger.log('error', ERROR_UNPACKING, err);
            onUnpackDone(err, null);
          });
      })();
    }
  },

  /**
   * Watch the course build folder where
   * Adapt AT works to preview the course.
   * Checks presence of OAM/ZIP files and unpacks
   * them if any.
   * @param watchingDir {string}
   */
  watchCourseOutputDir: function(watchingDir) {
    var monitor = fsmonitor.watch(watchingDir, {
      matches: function(relpath) {
        return (
          (relpath.match(/\.oam$/i) !== null)
        );
      },
      // exclude not needed directories
      // TODO: periodically review this list on new AT releases
      excludes: function(relpath) {
        return (
          relpath.match(/^\.git$/i) !== null ||
          relpath.match(/^\node_modules$/i) !== null ||
          relpath.match(/^\grunt/i) !== null ||
          relpath.match(/^\src/i) !== null
        );
      }
    });

    monitor.on('change', function onChange(changes) {
      var packagesList = [];

      for (var i in changes.addedFiles) {
        packagesList.push(path.join(watchingDir, changes.addedFiles[i]));
      }
      for (var ii in changes.modifiedFiles) {
        packagesList.push(path.join(watchingDir, changes.modifiedFiles[ii]));
      }
      //
      // Monitor.on('change') also returns "changes.removedFiles"
      // but we don't care about them since here we
      // are working with the course preview only,
      // and the output doesn't go into the course
      // export downloaded by the user.
      pluginInstance.unpack(packagesList, function onUnpacked(err) {
        if (err) {
          logger.log('error', ERROR_UNPACKING, err);
        }
      });
    });
  }
};


/**
 * Remove the redundant package
 * root generated by decompressing
 * the OAM/ZIP file. All included files
 * are moved one level up in the
 * directory tree.
 * @param packageDir {string}
 * @param filesFromPackage {object[]}
 */
function removePackageRoot(packageDir, filesFromPackage) {
  var entries = fs.readdirSync(packageDir);
  // there is a root in decompressed package...
  if (entries.length === 1) {
    var packageRoot = entries[0] + '/';

    // moves the files one level up
    // outside the root of the OAM/ZIP
    // package (redundant)
    for (var i in filesFromPackage) {
      var file = filesFromPackage[i];

      if (file.type === 'file') {
        var fileName = path.join(packageDir, file.path);
        var fileMovedOutsideRoot = fileName.replace(packageRoot, '');
        var fileDir = path.dirname(fileMovedOutsideRoot);
        fsextra.ensureDirSync(fileDir);
        fs.renameSync(fileName, fileMovedOutsideRoot);
      }
    }
    // removes the root folder of the extracted package now empty
    fsextra.removeSync(path.join(packageDir, packageRoot));
  }
}

/**
 * Checks if decompressed package has the
 * required standard structure.
 * Checks if the decompressed package OAM/ZIP
 * has an entry point file (index.html)
 * to be loaded in the iframe that is responsible
 * to showing the animation to the user.
 * If no entry point is found, error is returned.
 * @param packageDir {string}
 * @param filesFromPackage {object[]}
 * @param onValidationDone {function}: (err=null)
 * @return {function}
 */
function validatePackage(packageDir, filesFromPackage, onValidationDone) {
  var validationError = null;

  //are there contents?
  if(filesFromPackage.length === 0) {
    validationError = new Error(ERROR_EMPTY_PACKAGE+packageDir);
  }
  //has entry point index file?
  var hasIndexFile = false;
  for (var i in filesFromPackage) {
    if (filesFromPackage[i].path.toLocaleString().indexOf(ENTRY_FILE) !== -1) {
      hasIndexFile = true;
      break;
    }
  }
  if(!hasIndexFile) {
    validationError = new Error(ERROR_MISSING_ENTRY_POINT + packageDir);
  }

  return onValidationDone(validationError);
}

/**
 * Returns a singleton instance of the
 * class (performs watching over directory,
 * so must be singleton)
 * @return {{processDir: processDir, unpackOAMPackages: unpack, watchCourseOutputDir: watchCourseOutputDir}|*}
 */
AnimationAssetUnpack.getInstance = function() {
  if (!AnimationAssetUnpack.instance) {
    logger.log('info',INFO_INIT);

    AnimationAssetUnpack.instance = pluginInstance;

    // Initializes watching of course output
    // in temp build folder as soon as this
    // plugin is loaded into the AT
    AnimationAssetUnpack.instance.watchCourseOutputDir(WATCHING_DIR);
  }

  return AnimationAssetUnpack.instance;
};

// Creates the singleton and starts
// watching the temp fs dir
AnimationAssetUnpack.getInstance();


exports = module.exports = AnimationAssetUnpack;
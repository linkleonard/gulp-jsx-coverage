'use strict';

var gulp = require('gulp'),
    fs = require('fs'),
    babel = require('babel-core'),
    parseVLQ = require('parse-base64vlq-mappings'),
    sourceStore = undefined,
    finalSummary = undefined,
    sourceMapCache = {},

getDataURI = function (sourceMap) {
    return 'data:application/json;base64,' + new Buffer(unescape(encodeURIComponent(sourceMap)), 'binary').toString('base64');
},

fixSourceMapContent = function (sourceMap, source) {
    var map = JSON.parse(sourceMap);

    map.sourcesContent = [source];
    return map;
},

betterIndent = function (string, loc) {
    var size = string.length,
        newloc = size - (size % 4) + 8;

    if (newloc < loc) {
        newloc = loc;
    }

    return string + (new Array(newloc - size + 1)).join(' ');
},

addSourceComments = function (source, sourceMap, filename) {
    var oldlines,
        lines = source.split(/\n/),
        mappings = [],
        loc,
        line,
        outputs = [];

    if (sourceMap && sourceMap.sourcesContent && sourceMap.sourcesContent[0]) {
        sourceMap.newLines = lines.slice(0);
        oldlines = sourceMap.sourcesContent[0].split(/\n/);
        parseVLQ(sourceMap.mappings).forEach(function (P) {
            mappings[P.generated.line] = P.original.line;
        });
        mappings.forEach(function (V, I) {
            if (!V || !I || outputs[V]) {
                loc -= 8;
                return;
            }

            // Mapping once
            outputs[V] = 1;

            // Do not comment when transform nothing
            if (oldlines[V-1] === lines[I-1]) {
                return;
            }

            line = betterIndent(lines[I-1], loc);
            loc = line.length;

            // Add comment to hint original code
            lines[I-1] = line + '// ' + ((V!==I) ? ('Line ' + V + ': ') : '') + oldlines[V-1];
        });
        sourceMap.linemappings = mappings;
        sourceMap.oldLines = oldlines;
        sourceMapCache[filename] = sourceMap;
        source = lines.join('\n').replace(/\/\/# sourceMappingURL=.+/, '// SourceMap was distributed to comments by gulp-jsx-coverage');
    }

    return source;
},

// Never use node-jsx or other transform in your testing code!
initModuleLoaderHack = function (options) {
    var Module = require('module'),
        istanbul = require(options.isparta ? 'isparta' : 'istanbul'),
        instrumenter = new istanbul.Instrumenter(Object.assign(options.isparta ? {babelOptions: options.babel} : {}, options.istanbul)),
        babelFiles = Object.assign({
            include: /\.jsx?$/,
            exclude: /node_modules/,
            omitExt: false
        }, options.transpile ? options.transpile.babel : undefined),
        coffeeFiles = Object.assign({
            include: /\.coffee$/,
            exclude: /^$/,
            omitExt: false
        }, options.transpile ? options.transpile.coffee : undefined),

    moduleLoader = function (module, filename) {
        var srcCache = sourceStore.map[filename],
            src = srcCache || fs.readFileSync(filename, {encoding: 'utf8'}),
            tmp;

        if (srcCache) {
            return;
        }

        if (filename.match(babelFiles.include) && !filename.match(babelFiles.exclude)) {
            if (!options.sparta || !filename.match(options.istanbul.exclude)) {
                try {
                    tmp = babel.transform(src, Object.assign({
                        filename: filename
                    }, options.babel));
                    srcCache = tmp.map || 1;
                    src = tmp.code;
                } catch (e) {
                    throw new Error('Error when transform es2015/jsx ' + filename + ': ' + e.toString());
                }
            }
        }

        if (filename.match(coffeeFiles.include) && !filename.match(coffeeFiles.exclude)) {
            try {
                tmp = require('coffee-script').compile(src, options.coffee);
                srcCache = tmp.v3SourceMap ? fixSourceMapContent(tmp.v3SourceMap, src) : 1;
                src = tmp.js + '\n//# sourceMappingURL=' + getDataURI(JSON.stringify(srcCache));
            } catch (e) {
                throw new Error('Error when transform coffee ' + filename + ': ' + e.toString());
            }
        }

        if (srcCache) {
            sourceStore.set(filename, addSourceComments(src, srcCache, filename));
        }

        // Don't instrument files that aren't meant to be
        if (!filename.match(options.istanbul.exclude)) {
            try {
                src = instrumenter.instrumentSync(src, filename);
            } catch (e) {
                throw new Error('Error when instrument ' + filename + ': ' + e.toString());
            }
        }

        module._compile(src, filename);
    };

    global[options.istanbul.coverageVariable] = {};
    sourceStore = istanbul.Store.create('memory');
    sourceStore.dispose();
    sourceMapCache = {};

    Module._extensions['.js'] = moduleLoader;
    if (babelFiles.omitExt) {
        babelFiles.omitExt.forEach(function (V) {
            Module._extensions[V] = moduleLoader;
        });
    }
    if (coffeeFiles.omitExt) {
        coffeeFiles.omitExt.forEach(function (V) {
            Module._extensions[V] = moduleLoader;
        });
    }
},

stackDumper = function (stack) {
    return stack.replace(/\((.+?):(\d+):(\d+)\)/g, function (M, F, L, C) {
        var sourcemap = sourceMapCache[F];
        var l = 0;

        if (!sourcemap) {
            return M;
        }

        l = sourcemap.linemappings[L];

        if (l === undefined) {
            return M + '\nTRANSPILED: ' + sourcemap.newLines[L - 1];
        }

        return '(' + F + ':' + l + ':-1)' + '\nORIGINALSRC: ' + sourcemap.oldLines[l - 1] + '\nTRANSPILED : ' + sourcemap.newLines[L - 1] + '\t// line ' + L + ',' + C + '\n' + (new Array(C * 1 + 13)).join('-') + '^';
    });
},

getCustomizedMochaStackTraceFilter = function () {
    return stackDumper;
},

GJC = {
    oldMochaStackTraceFilter: undefined,
    initModuleLoaderHack: function (options) {
        initModuleLoaderHack(options);
    },
    collectIstanbulCoverage: function (options) {
        return function () {
            var istanbul = require(options.isparta ? 'isparta' : 'istanbul'),
                collector = new istanbul.Collector();

            collector.add(global[options.istanbul.coverageVariable]);

            finalSummary = istanbul.utils.mergeSummaryObjects.apply(null, collector.files().map(function (F) {
                return istanbul.utils.summarizeFileCoverage(collector.fileCoverageFor(F));
            }));

            options.coverage.reporters.forEach(function (R) {
                istanbul.Report.create(R, {
                    sourceStore: sourceStore,
                    dir: options.coverage.directory
                }).writeReport(collector, true);
            });

            if ('function' === (typeof options.cleanup)) {
                options.cleanup(this);
            }

            if (options.threshold) {
                GJC.failWithThreshold(options.threshold, options.thresholdType).apply(this);
            }

            GJC.disableStackTrace();
        }
    },
    disableStackTrace: function () {
        if (GJC.oldMochaStackTraceFilter) {
            require('mocha/lib/utils').stackTraceFilter = GJC.oldMochaStackTraceFilter;
        }
    },
    enableStackTrace: function () {
        if (!GJC.oldMochaStackTraceFilter) {
            GJC.oldMochaStackTraceFilter = require('mocha/lib/utils').stackTraceFilter;
        }
        require('mocha/lib/utils').stackTraceFilter = getCustomizedMochaStackTraceFilter;
    },
    failWithThreshold: function (threshold, type) {
        return function () {
            var T = type || 'lines';
            if (!finalSummary || !threshold) {
                return;
            }
            if (finalSummary[T].pct < threshold) {
                this.emit('error', new (require('gulp-util').PluginError)({
                    plugin: 'gulp-jsx-coverage',
                    message: T + ' coverage ' + finalSummary[T].pct + '% is lower than threshold ' + threshold + '%!'
                }));
            }
        }
    },
    createTask: function (options) {
        return function () {
            GJC.initModuleLoaderHack(options);
            GJC.enableStackTrace();

            return gulp.src(options.src)
            .pipe(require('gulp-mocha')(options.mocha))
            .on('end', GJC.collectIstanbulCoverage(options));
        };
    }
};

module.exports = GJC;

require('object.assign').shim();

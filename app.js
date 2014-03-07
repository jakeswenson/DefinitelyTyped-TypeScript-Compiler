/// <reference path="typescript.d.ts" />
var spawn = require('child_process').spawn;
var GitHubApi = require("node-github");
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var TypeScript = require('./nodets.js');

var currentFolder = __dirname;

function getDownloadFolder(user) {
    return path.join(currentFolder, '../definitelyTypedFiles', user);
}
function getStatusFile(user) {
    return path.join(getDownloadFolder(user), 'status.json');
}
function getTreeFile(user) {
    return path.join(getDownloadFolder(user), 'tree.json');
}
function getResultsFolder(user) {
    if (user === defaultUser) {
        return path.join(currentFolder, '../definitelyTyped/');
    }

    return path.join(currentFolder, '../definitelyTyped/', user);
}

var typescript = path.join(currentFolder, '../typescript/built/local/tsc.js');

var GitHub;
(function (GitHub) {
    // only get 5000 request a day, if this becomes an issue get your own token.
    var gitHubAuthToken = 'cc6e134f1a93c61f30a2bd92fede31ad88109fcf';
    var gitHubAuth = {
        type: "oauth",
        token: gitHubAuthToken
    };

    var gitHubOpts = {
        version: "3.0.0",
        timeout: 5000
    };

    function createGitHub() {
        var github = new GitHubApi(gitHubOpts);
        github.authenticate(gitHubAuth);
        return github;
    }
    GitHub.createGitHub = createGitHub;
})(GitHub || (GitHub = {}));

var compilationList = {
    users: ['borisyankov', 'guiserrato'],
    repo: 'DefinitelyTyped'
};

var userCount = compilationList.users.length;
var defaultUser = 'borisyankov';

var Compilation;
(function (Compilation) {
    var TypeScriptCompiler;
    (function (TypeScriptCompiler) {
        function getLocationText(location) {
            return location.fileName() + "(" + (location.line() + 1) + "," + (location.character() + 1) + ")";
        }

        function getFullDiagnosticText(diagnostic) {
            var result = "";
            if (diagnostic.fileName()) {
                result += getLocationText(diagnostic) + ": ";
            }

            result += diagnostic.message();

            var additionalLocations = diagnostic.additionalLocations();
            if (additionalLocations.length > 0) {
                result += " " + TypeScript.getLocalizedText(TypeScript.DiagnosticCode.Additional_locations, null) + TypeScript.Environment.newLine;

                for (var i = 0, n = additionalLocations.length; i < n; i++) {
                    result += "\t" + getLocationText(additionalLocations[i]) + TypeScript.Environment.newLine;
                }
            } else {
                result += TypeScript.Environment.newLine;
            }

            return result;
        }

        var libdts = path.join(currentFolder, 'lib.d.ts');
        var libdtsText = fs.readFileSync(libdts);

        var Logger = (function () {
            function Logger() {
            }
            Logger.prototype.log = function (msg) {
                console.log(msg);
            };
            Logger.prototype.information = function () {
                return true;
            };
            Logger.prototype.debug = function () {
                return true;
            };
            Logger.prototype.warning = function () {
                return true;
            };
            Logger.prototype.error = function () {
                return true;
            };
            Logger.prototype.fatal = function () {
                return true;
            };

            Logger.instance = new Logger();
            return Logger;
        })();

        var ResolverHost = (function () {
            function ResolverHost() {
            }
            ResolverHost.prototype.getScriptSnapshot = function (fileName) {
                var text = fs.readFileSync(fileName);
                return TypeScript.ScriptSnapshot.fromString(text.toString());
            };

            ResolverHost.prototype.resolveRelativePath = function (to, from) {
                var rel = path.resolve(from, to);

                //console.log('Resolving Path from:', from, 'to:', to, 'is', rel);
                return rel;
            };
            ResolverHost.prototype.fileExists = function (path) {
                var e = fs.existsSync(path);

                //console.log("File exists?", path, e);
                if (!e) {
                    return false;
                }
                var stats = fs.statSync(path);

                //console.log("is file", stats.isFile());
                return stats && stats.isFile();
            };
            ResolverHost.prototype.directoryExists = function (path) {
                var e = fs.existsSync(path);
                if (!e) {
                    return e;
                }
                var stats = fs.statSync(path);

                //console.log("is dir", stats.isDirectory());
                return stats && stats.isDirectory();
            };
            ResolverHost.prototype.getParentDirectory = function (dir) {
                var p = path.dirname(dir);
                if (p === dir)
                    return null;
                return p;
            };

            ResolverHost.Current = new ResolverHost();
            return ResolverHost;
        })();

        function getCompiler() {
            var settings = new TypeScript.CompilationSettings();
            var immSettings = TypeScript.ImmutableCompilationSettings.fromCompilationSettings(settings);

            var compiler = new TypeScript.TypeScriptCompiler(Logger.instance, immSettings);

            compiler.addFile(libdts, TypeScript.ScriptSnapshot.fromString(libdtsText.toString()), TypeScript.ByteOrderMark.None, 1, true, function (file) {
                throw file;
            });

            return compiler;
        }

        function addFile(compiler, fileName, callback) {
            console.log('Adding file', fileName, 'to compiler');

            fs.readFile(fileName, function (err, fileData) {
                if (err) {
                    throw err;
                }
                var scriptSnapshot = TypeScript.ScriptSnapshot.fromString(fileData.toString());
                compiler.addFile(fileName, scriptSnapshot, TypeScript.ByteOrderMark.None, 1, true);
                callback(compiler);
            });
        }

        function addFiles(compiler, files, callback) {
            if (!files || files.length === 0) {
                callback(compiler);
                return;
            }

            addFile(compiler, files.pop(), function (compiler) {
                addFiles(compiler, files, callback);
            });
        }

        function runCompiler(fileName, callback) {
            setTimeout(function () {
                var compiler = getCompiler();

                console.log('\r\nResolving references for', fileName);

                var resolution = TypeScript.ReferenceResolver.resolve([fileName], ResolverHost.Current, true);

                //console.log("File resolution complete", resolution.resolvedFiles.join(', '), resolution.diagnostics.length);
                var files = [];

                resolution.resolvedFiles.forEach(function (file) {
                    file.referencedFiles.forEach(function (ref) {
                        return files.push(ref);
                    });
                    //file.importedFiles.forEach(ref => files.push(ref));
                });

                files.push(fileName);

                var hasResolutionErrors = resolution.diagnostics.length > 0;

                //console.log('has resolution errors', hasResolutionErrors);
                if (hasResolutionErrors) {
                    callback({
                        error: resolution.diagnostics.map(function (diag) {
                            return diag.text() + "\r\n";
                        }),
                        exitCode: resolution.diagnostics.length,
                        out: []
                    });
                    return;
                }

                addFiles(compiler, files, function (compiler) {
                    console.log('Getting diagnostics for', fileName);

                    var syntaxDiag = compiler.getSyntacticDiagnostics(fileName);
                    var semanticDiag = compiler.getSemanticDiagnostics(fileName);
                    var errors = syntaxDiag.concat(semanticDiag).map(function (diag) {
                        return getFullDiagnosticText(diag);
                    });

                    callback({
                        error: errors,
                        exitCode: errors.length,
                        out: []
                    });
                });
            }, 1);
        }

        function getTypeScriptCompiler(files, callback) {
            callback(runCompiler);
        }
        TypeScriptCompiler.getTypeScriptCompiler = getTypeScriptCompiler;
    })(TypeScriptCompiler || (TypeScriptCompiler = {}));

    var NodeCompiler;
    (function (NodeCompiler) {
        function getNodeRunner(files, callback) {
            callback(function (file, callback) {
                console.log('compiling', file);
                var output = { out: [], error: [], exitCode: -1 };
                var compiler = spawn('node', [typescript, file]);
                compiler.stdout.on('data', function (data) {
                    output.out.push(data.toStriong());
                });

                compiler.stderr.on('data', function (data) {
                    output.error.push(data.toString());
                });

                compiler.on('close', function (code) {
                    output.exitCode = code;
                    callback(output);
                });
            });
        }
    })(NodeCompiler || (NodeCompiler = {}));

    var compilerFactory = TypeScriptCompiler.getTypeScriptCompiler;

    function scheduleCompile(user, files, runData) {
        setTimeout(function () {
            compile(user, files, runData);
        }, 1);
    }
    Compilation.scheduleCompile = scheduleCompile;

    function compile(user, files, runData) {
        var compileResults = {};
        var compilationState = {
            lastGitHubUpdate: runData.updatedAt,
            lastCommit: runData.lastCommit,
            compileStart: new Date(),
            compileResults: compileResults,
            compileEnd: new Date()
        };

        console.log('Starting compile for', user);

        function writeCompilationResults() {
            var compileEnd = new Date();
            compilationState.compileEnd = compileEnd;

            console.log(user, 'compile done!!');

            var folderPath = getResultsFolder(user);

            fs.mkdir(folderPath, function () {
                var filePath = path.join(folderPath, 'results.json');

                fs.writeFile(filePath, JSON.stringify(compilationState), function () {
                    console.log(user, 'result file written to:', filePath);
                });
            });
        }

        compilerFactory(files, function (compiler) {
            function compileOne(file, finish) {
                compiler(file, function (output) {
                    compileResults[file] = output;

                    if (files.length > 0) {
                        var nextFile = files.pop();
                        compileOne(nextFile, finish);
                    } else {
                        finish();
                    }
                });
            }

            compileOne(files.pop(), writeCompilationResults);
        });
    }
    Compilation.compile = compile;
})(Compilation || (Compilation = {}));

var GitHub;
(function (GitHub) {
    (function (DefinitelyTyped) {
        function finishDownload(user, lastCommit, lastUpdate, compilerFiles) {
            console.log('done getting files');

            var runData = {
                lastCommit: lastCommit,
                updatedAt: lastUpdate,
                files: compilerFiles
            };

            fs.writeFile(getStatusFile(user), JSON.stringify(runData), function (err) {
                if (err) {
                    throw err;
                }
                Compilation.scheduleCompile(user, compilerFiles, runData);
            });
        }

        function processBlob(user, repo, latestCommit, lastUpdatedAt, file, files, compilerFiles) {
            if (!file || !file.path) {
                console.log('File has no path', JSON.stringify(file), files.length);
                return;
            }

            var github = GitHub.createGitHub();

            var outputFile = path.join(getDownloadFolder(user), file.path);

            function processNext() {
                compilerFiles.push(outputFile);
                if (files.length === 0) {
                    finishDownload(user, latestCommit, lastUpdatedAt, compilerFiles);
                } else {
                    processBlob(user, repo, latestCommit, lastUpdatedAt, files.pop(), files, compilerFiles);
                }
            }

            function fileChanged(fileName, sha, result) {
                fs.exists(fileName, function (exists) {
                    if (!exists) {
                        result(true);
                        return;
                    }

                    fs.readFile(fileName, function (err, data) {
                        if (err) {
                            throw err;
                        }
                        var hasher = crypto.createHash('sha1');
                        hasher.update(data);
                        var hash = hasher.digest('hex');
                        var hasChanged = sha !== hash;

                        //console.log('file', fileName, 'has changed', hasChanged);
                        result(hasChanged);
                    });
                });
            }

            // can't trust file.sha, its not the file's sha...
            fileChanged(outputFile, file.sha, function (changed) {
                if (!changed) {
                    processNext();
                    return;
                }

                github.gitdata.getBlob({
                    user: user,
                    repo: repo,
                    sha: file.sha
                }, function (err, blob) {
                    if (err) {
                        console.error('error with file ', file.path, 'error:', err);
                        if (files.length === 0) {
                            console.log('done');
                        }
                        return;
                    } else if (blob.size !== file.size || blob.sha !== file.sha) {
                        console.log('blob sha', blob.sha);
                        console.warn('File Size mismatch: ', file.size, blob.size, blob.url, file.url);
                        return;
                    }

                    console.log('Writing file contents', outputFile, '-', blob.size);
                    console.log('remaining:', files.length, 'api calls left:', blob.meta['x-ratelimit-remaining']);

                    fs.writeFile(outputFile, new Buffer(blob.content, 'base64'), function () {
                        processNext();
                    });
                });
            });
        }

        function processTree(github, info, latestCommit, lastUpdatedAt) {
            github.gitdata.getTree({
                user: info.user,
                repo: info.repo,
                sha: latestCommit,
                recursive: true
            }, function (err, tree) {
                if (err) {
                    console.error('error:', err);
                    throw err;
                }

                fs.mkdir(getDownloadFolder(info.user), function () {
                    fs.writeFile(getTreeFile(info.user), JSON.stringify(tree), function (err) {
                        if (err) {
                            throw err;
                        }
                    });

                    var dtsFiles = tree.tree.filter(function (file) {
                        return file.type === "blob" && /\.d\.ts$/.test(file.path) && !/^_/.test(file.path);
                    });

                    console.log('processing tree .d.ts files:', dtsFiles.length, tree.url);

                    var files = [];
                    var makeDirCount = dtsFiles.length;

                    function startProcessingBlobs() {
                        processBlob(info.user, info.repo, latestCommit, lastUpdatedAt, files.pop(), files, []);
                    }

                    function madeDir() {
                        if (--makeDirCount === 0) {
                            startProcessingBlobs();
                        }
                    }

                    dtsFiles.forEach(function (file) {
                        var outputDir = path.join(getDownloadFolder(info.user), path.dirname(file.path));
                        files.push(file);

                        if (!fs.existsSync(outputDir)) {
                            console.log('makingdir: ', outputDir);
                            fs.mkdirSync(outputDir);
                            madeDir();
                        } else {
                            madeDir();
                        }
                    });
                });
            });
        }

        function processCommits(github, info, lastUpdatedAt) {
            github.repos.getCommits({
                user: info.user,
                repo: info.repo,
                per_page: 1
            }, function (err, commits) {
                if (err) {
                    console.error('error:', err);
                    return;
                }

                var latestCommit = commits[0].sha;
                console.log(info.user, info.repo, 'most recent commit', latestCommit);

                var statusFile = getStatusFile(info.user);

                fs.exists(statusFile, function (exists) {
                    if (exists) {
                        fs.readFile(statusFile, function (err, fileJSON) {
                            if (err) {
                                throw err;
                            }
                            var lastRunData = JSON.parse(fileJSON);
                            if (lastRunData.lastCommit === latestCommit) {
                                console.log(info.user, 'Last commit is latest, recompiling');
                                Compilation.scheduleCompile(info.user, lastRunData.files, lastRunData);
                                return;
                            } else {
                                console.log(info.user, 'latest commit', latestCommit, 'last processed', lastRunData.lastCommit);
                            }

                            processTree(github, info, latestCommit, lastUpdatedAt);
                        });
                        return;
                    }

                    processTree(github, info, latestCommit, lastUpdatedAt);
                });
            });
        }

        function processRepo(github, user, repo) {
            var info = { user: user, repo: repo };

            github.repos.get(info, function (err, repoInfo) {
                if (err) {
                    console.error('error:', err);
                    throw err;
                }

                var lastUpdatedAt = new Date(repoInfo.updated_at);
                console.log(user, repo, "updated at:", lastUpdatedAt);

                processCommits(github, info, lastUpdatedAt);
            });
        }
        DefinitelyTyped.processRepo = processRepo;
    })(GitHub.DefinitelyTyped || (GitHub.DefinitelyTyped = {}));
    var DefinitelyTyped = GitHub.DefinitelyTyped;
})(GitHub || (GitHub = {}));

compilationList.users.forEach(function (user) {
    console.log('Processing repository "', compilationList.repo, '" for user', user);
    GitHub.DefinitelyTyped.processRepo(GitHub.createGitHub(), user, compilationList.repo);
});

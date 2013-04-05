var fs = require('fs')
  , falafel = require('falafel')
  , colors = require('colors');


/** 
 * Colonize
 */

var keywords = ["end"];
var mask = ['string', 'math', 'print'];
var locals = ['this', 'global', 'Object', 'Array', 'String', 'Math', 'require', 'console']

function fixIdentifiers (str) {
  if (keywords.indexOf(str) > -1) {
    return '_K_' + str;
  }
  return str.replace(/_/g, '__').replace(/\$/g, '_S');
}

function uniqueStrings (arr) {
  var o = {};
  arr.forEach(function (k) {
    o[k] = true;
  });
  return Object.keys(o);
}

function attachIdentifierToContext (id, node) {
  var name = fixIdentifiers(id.source());
  while (node = node.parent) {
    if (node.type == 'FunctionDeclaration' || node.type == 'Program' || node.type == 'FunctionExpression') {
      (node.identifiers || (node.identifiers = [])).push(name);
      node.identifiers = uniqueStrings(node.identifiers);
      return;
    }
  }
}

function truthy (node) {
  if (['!', '<', '<=', '>', '>=', '===', '!=', '!==', 'instanceof', 'in'].indexOf(node.operator) == -1) {
    node.update("_JS._truthy(" + node.source() + ")");
  }
  return node.source();
}

function colonizeContext (ids, node) {
  if (ids) {
    ids = ids.filter(function (id) {
      return id != 'arguments';
    });
  }
  node.update([
    // Variables
    ids && ids.length ? 'local ' + ids.join(', ') + ';' : '',
    // Hoist Functions
    node.body.filter(function (stat) {
      return stat.type == 'FunctionDeclaration';
    }).map(function (stat) {
      return stat.source();
    }).join('\n'),
    // Statements
    node.body.filter(function (stat) {
      return stat.type != 'FunctionDeclaration';
    }).map(function (stat) {
      return stat.source();
    }).join('\n')
  ].filter(function (n) {
    return n;
  }).join('\n'));
}

var labels = [];
var loops = [];

function colonize (node) {
  
  switch (node.type) {
    case 'Identifier':
      if (node.source() == 'arguments') {
        attachIdentifierToContext(node, node);
      }
      node.update(fixIdentifiers(node.source()));
      break;

    case 'AssignmentExpression':
      // +=, -=, etc.
      if (node.operator != '=') {
        node.right.update(node.left.source() + ' ' + node.operator.substr(0, 1) + ' ' + node.right.source());
        node.operator = '=';
      }
      // Used in another expression, assignments must be wrapped by a closure.
      if (node.parent.type != 'ExpressionStatement') {
        node.update('(function () local _r = ' + node.right.source() + '; ' + node.left.source() + ' = _r; return _r; end)()');
      } else {
        // Need to refresh thanks to += updating.
        node.update(node.left.source() + ' = ' + node.right.source());
      }
      break;

    case 'ThisExpression':
      break;  

    case 'UnaryExpression':
      if (node.operator == '!') {
        node.update('(not ' + node.argument.source() + ')');
      } else {
        node.update('(' + node.source() + ')');
      }
    case 'BinaryExpression':
      if (node.operator == '!==' || node.operator == '!=') {
        // TODO strict
        node.update('(' + node.left.source() + ' ~= ' + node.right.source() + ')');
      } else if (node.operator == '<<') {
        node.update('_JS._bit.lshift(' + node.left.source() + ', ' + node.right.source() + ')');
      } else {
        node.update('(' + node.source() + ')');
      }
      break;

    case 'LogicalExpression':
      if (node.operator == '&&') {
        node.update(node.left.source() + ' and ' + node.right.source());
      } else if (node.operator == '||') {
        node.update(node.left.source() + ' or ' + node.right.source());
      }

      // Can't have and/or be statements.
      if (node.parent.type == 'ExpressionStatement') {
        node.update('if ' + node.source() + ' then end');
      }
      break;

    case 'UpdateExpression':
      // ++ or --
      if (node.prefix) {
        node.update('(function () ' + node.argument.source() + ' = ' + node.argument.source() + ' ' + node.operator.substr(0, 1) + ' 1; return ' + node.argument.source() + '; end)()');
      } else {
        node.update('(function () local _r = ' + node.argument.source() + '; ' + node.argument.source() + ' = _r ' + node.operator.substr(0, 1) + ' 1; return _r end)()');
      }
      break;

    case 'NewExpression':
      node.update("_JS._new(" +
        [node.callee.source()].concat(node.arguments.map(function (arg) {
          return arg.source();
        })).join(', ') + ")");
      break;

    case 'VariableDeclarator':
      attachIdentifierToContext(node.id, node);
      break;

    case 'VariableDeclaration':
      node.update(node.declarations.map(function (d) {
        return d.id.source();
      }).join(', ') + ' = ' + node.declarations.map(function (d) {
        return d.init ? d.init.source() : 'nil'
      }).join(', ') + ';');
      break;

    case 'BreakStatement':
      //TODO _c down the stack is false until the main one
      //label = label or (x for x in loops when loops[0] != 'try')[-1..][0]?[1] or ""

      var label = node.label ? node.label.source() : '';
      node.update("_c" + label + " = _JS._break; break;");
      break;


    case 'ContinueStatement':
      //TODO _c down the stack is false until the main one
      //label = label or (x for x in loops when loops[0] != 'try')[-1..][0]?[1] or ""

      var label = node.label ? node.label.source() : '';

      var par = node;
      while (par = par.parent) {
        if (par.type == 'WhileStatement' || par.type == 'ForStatement') {
          par.usesContinue = true;
        }
      }
      node.update("_c" + label + " = _JS._cont; break;");
      break;

    case 'DoWhileStatement':
      var name = node.parent.type == 'LabeledStatement' ? node.parent.label.source() :'';

      var loops = [];
      var par = node;
      while (par = par.parent) {
        if (par.type == 'WhileStatement' || par.type == 'ForStatement') {
          var parname = par.parent.type == 'LabeledStatement' ? par.parent.label.source() :'';
          loops.unshift([par.type, parname, node.usesContinue]);
        }
      }
      var ascend = loops.filter(function (l) {
        return l[0] != 'TryStatement' && l[1] != null;
      }).map(function (l) {
        return l[1];
      });

      node.update([
        'repeat',
        (node.usesContinue ? 'local _c' + name + ' = nil; repeat' : ''),
        node.body.source(),
        (node.usesContinue ? 'until true;\nif _c' + name + ' == _JS._break' + [''].concat(ascend).join(' or _c') + ' then break end' : ''),
        'until not ' + truthy(node.test) + ';'
      ].join('\n'))
      break;

    case 'WhileStatement':
      var name = node.parent.type == 'LabeledStatement' ? node.parent.label.source() :'';

      var loops = [];
      var par = node;
      while (par = par.parent) {
        if (par.type == 'WhileStatement' || par.type == 'ForStatement') {
          var parname = par.parent.type == 'LabeledStatement' ? par.parent.label.source() :'';
          loops.unshift([par.type, parname, node.usesContinue]);
        }
      }
      var ascend = loops.filter(function (l) {
        return l[0] != 'TryStatement' && l[1] != null;
      }).map(function (l) {
        return l[1];
      });

      node.update([
        'while ' + truthy(node.test) + ' do',
        (node.usesContinue ? 'local _c' + name + ' = nil; repeat' : ''),
        node.body.source(),
        (node.usesContinue ? 'until true;\nif _c' + name + ' == _JS._break' + [''].concat(ascend).join(' or _c') + ' then break end' : ''),
        'end'
      ].join('\n'))
      break;

    case 'ForStatement':
      node.update([
        node.init ? node.init.source() : '',
        'while ' + (node.test ? truthy(node.test) : 'true') + ' do',
        (node.usesContinue ? 'local _c = nil; repeat' : ''),
        node.body.source(),
        (node.usesContinue ? 'until true;\nif _c == _JS._break then break end' : ''),
        node.update ? node.update.source() : '',
        'end'
      ].join('\n'))
      break;

    case 'Literal':
      node.update('(' + JSON.stringify(node.value) + ')');
      break;

    case 'CallExpression':
      if (node.callee.type == 'MemberExpression') {
        // Method call
        node.update(node.callee.object.source() + ':'
          + node.callee.property.source()
          // + '[' + (node.callee.property.type == 'Identifier' ? JSON.stringify(node.callee.property.source()) : node.callee.property.source()) + ']'
          + '(' + node.arguments.map(function (arg) {
          return arg.source()
        }).join(', ') + ')')
      } else {
        node.update(node.callee.source() + '(' + ['global'].concat(node.arguments.map(function (arg) {
          return arg.source()
        })).join(', ') + ')')
      }
      break;

    case 'ObjectExpression':
      node.update('_JS._obj({})')
      break;

    case 'ArrayExpression':
      if (!node.elements.length) {
        node.update("_JS._arr({})");
      } else {
        node.update("_JS._arr({[0]=" + [].concat(node.elements.map(function (el) {
          return el.source();
        })).join(', ') + "})");
      }
      break;

    case 'ConditionalExpression':
      node.update('(' + truthy(node.test) + ' and {' + node.consequent.source() + '} or {' + node.alternate.source() + '})[1]');
      break;

    case 'IfStatement':
      node.update([
        "if " + truthy(node.test) + " then\n",
        node.consequent.source() + '\n',
        (node.alternate ? 'else\n' + node.alternate.source() + '\n' : ""),
        "end"
      ].join(''));
      break;

    case 'ReturnStatement':
      // Wrap in conditional to allow returns to precede statements
      node.update("if true then return" + (node.argument ? ' ' + node.argument.source() : '') + "; end;");
      break;

    case 'BlockStatement':
      colonizeContext(node.parent.type == 'FunctionDeclaration' || node.parent.type == 'FunctionExpression' ? node.parent.identifiers : [], node);
      break;

    case 'MemberExpression':
      if (!node.parent.type == 'CallExpression') {
        node.update("(" + node.object.source() + ")"
          + '[' + (node.property.type == 'Identifier' ? JSON.stringify(node.property.source()) : node.property.source()) + ']');
      }
      break;

    case 'ExpressionStatement':
      node.update(node.source().replace(/;?$/, ';'));
      break;

    case 'LabeledStatement':
      // TODO change stat to do { } while(false) unless of certain type;
      // this makes this labels array work
      node.update(node.body.source());
      break;

    case 'ForInStatement':
      if (node.left.type == 'VariableDeclaration') {
        var name = fixIdentifiers(node.left.declarations[0].id.name);
      } else {
        var name = node.left.source();
      }
      node.update([
        'for ' + name + ' in pairs(' + node.right.source() + ') do',
        node.body.source(),
        'end'
      ].join('\n'))
      break;

    case 'FunctionExpression':
    case 'FunctionDeclaration':
      if (node.id && !node.expression) {
        attachIdentifierToContext(node.id, node);
      }

      node.identifiers || (node.identifiers = []);

      // fix references
      var name = node.id && node.id.source();
      var args = node.params.map(function (arg) {
        return arg.source();
      });

      // expression prefix/suffix
      if (!node.expression && node.parent.type != 'CallExpression' && name) {
        // TODO among other types of expressions...
        var prefix = name + ' = ', suffix = ';';
      } else {
        var prefix = '', suffix = '';
      }

      // assign self-named function reference only when necessary
      var namestr = "";
      if (node.identifiers.indexOf(name) > -1) {
        namestr = "local " + name + " = debug.getinfo(1, 'f').func;\n";
      }

      var loopsbkp = loops;
      var loops = [];
      if (node.identifiers.indexOf('arguments') > -1) {
        node.update(prefix + "_JS._func(function (this, ...)\n" + namestr +
          "local arguments = _JS._arr((function (...) return arg; end)(...)); arguments:shift();\n" +
          (args.length ? "local " + args.join(', ') + " = ...;\n" : "") +
          node.body.source() + "\n" +
          "end)" + suffix);
      } else {
        node.update(prefix + "_JS._func(function (" + ['this'].concat(args).join(', ') + ")\n" + namestr +
          node.body.source() + "\n" +
          "end)" + suffix);
      }

      loops = loopsbkp;
      break;

    case 'Program':
      colonizeContext(node.identifiers, node);
      node.update([
        "local _JS = require('colony-js');",
        "local " + mask.join(', ') + ' = ' + mask.map(function () { return 'nil'; }).join(', ') + ';',
        "local " + locals.join(', ') + ' = ' + locals.map(function (k) { return '_JS.' + k; }).join(', ') + ';',
        "local _module = {exports={}}; local exports = _module.exports;",
        "",
        node.source(),
        "",
        "return _module.exports;"
      ].join('\n'));
      break;

    default:
      console.log(node.type.red, node);
  }
}


/**
 * Output
 */

if (process.argv.length < 3) {
  console.error('node colony filepath.js');
  process.exit(1);
}

var src = fs.readFileSync(process.argv[2], 'utf-8');
var out = falafel(src, colonize);
console.log(String(out).replace(/\/\//g, '--'));
import { SQL_Value, SQL_ValueString, SQL_ValueBool } from '../sql-parser';
import { assert, prefixSuccessor, astValueToNative } from '../utils';

export function applyWhere(
  queries: firebase.firestore.Query[],
  astWhere: { [k: string]: any }
): firebase.firestore.Query[] {
  if (astWhere.type === 'binary_expr') {
    if (astWhere.operator === 'AND') {
      queries = applyWhere(queries, astWhere.left);
      queries = applyWhere(queries, astWhere.right);
    } else if (astWhere.operator === 'OR') {
      queries = [
        ...applyWhere(queries, astWhere.left),
        ...applyWhere(queries, astWhere.right)
      ];
    } else if (astWhere.operator === 'IN') {
      assert(
        astWhere.left.type === 'column_ref',
        'Unsupported WHERE type on left side.'
      );
      assert(
        astWhere.right.type === 'expr_list',
        'Unsupported WHERE type on right side.'
      );

      const newQueries: firebase.firestore.Query[] = [];
      astWhere.right.value.forEach((valueObj: SQL_Value) => {
        newQueries.push(
          ...applyCondition(queries, astWhere.left.column, '=', valueObj)
        );
      });
      queries = newQueries;
    } else if (astWhere.operator === 'LIKE') {
      assert(
        astWhere.left.type === 'column_ref',
        'Unsupported WHERE type on left side.'
      );
      assert(
        astWhere.right.type === 'string',
        'Only strings are supported with LIKE in WHERE clause.'
      );

      const whereLike = parseWhereLike(astWhere.right.value);

      if (whereLike.equals !== void 0) {
        queries = applyCondition(
          queries,
          astWhere.left.column,
          '=',
          whereLike.equals
        );
      } else if (whereLike.beginsWith !== void 0) {
        const successorStr = prefixSuccessor(whereLike.beginsWith.value);
        queries = applyCondition(
          queries,
          astWhere.left.column,
          '>=',
          whereLike.beginsWith
        );
        queries = applyCondition(
          queries,
          astWhere.left.column,
          '<',
          stringASTWhereValue(successorStr)
        );
      } else {
        throw new Error(
          'Only terms in the form of "value%" (string begins with value) and "value" (string equals value) are supported with LIKE in WHERE clause.'
        );
      }
    } else if (astWhere.operator === 'BETWEEN') {
      assert(
        astWhere.left.type === 'column_ref',
        'Unsupported WHERE type on left side.'
      );
      assert(
        astWhere.right.type === 'expr_list' &&
          astWhere.right.value.length === 2,
        'BETWEEN needs 2 values in WHERE clause.'
      );

      queries = applyCondition(
        queries,
        astWhere.left.column,
        '>=',
        astWhere.right.value[0]
      );
      queries = applyCondition(
        queries,
        astWhere.left.column,
        '<=',
        astWhere.right.value[1]
      );
    } else if (astWhere.operator === 'CONTAINS') {
      assert(
        astWhere.left.type === 'column_ref',
        'Unsupported WHERE type on left side.'
      );
      assert(
        ['string', 'number', 'bool', 'null'].includes(astWhere.right.type),
        'Only strings, numbers, booleans, and null are supported with CONTAINS in WHERE clause.'
      );

      queries = applyCondition(
        queries,
        astWhere.left.column,
        astWhere.operator,
        astWhere.right
      );
    } else {
      assert(
        astWhere.left.type === 'column_ref',
        'Unsupported WHERE type on left side.'
      );

      queries = applyCondition(
        queries,
        astWhere.left.column,
        astWhere.operator,
        astWhere.right
      );
    }
  } else if (astWhere.type === 'column_ref') {
    // The query is like "... WHERE column_name", so lets return
    // the documents where "column_name" is true. Ideally we would
    // include any document where "column_name" is truthy, but there's
    // no way to do that with Firestore.
    queries = queries.map(query => query.where(astWhere.column, '==', true));
  } else {
    throw new Error('Unsupported WHERE clause');
  }

  return queries;
}

function applyCondition(
  queries: firebase.firestore.Query[],
  field: string,
  astOperator: string,
  astValue: SQL_Value
): firebase.firestore.Query[] {
  /*
   TODO: Several things:

    - If we're applying a range condition to a query (<, <=, >, >=)
      we need to make sure that any other range condition on that same
      query is only applied to the same field. Firestore doesn't
      allow range conditions on several fields in the same query.

    - If we apply a range condition, the first .orderBy() needs to
      be on that same field. We should wait and only apply it if
      the user has requested an ORDER BY. Otherwise, they might be
      expecting the results ordered by document id.

    - Can't combine "LIKE 'value%'" and inequality filters (>, <=, ...)
      with AND:
        SELECT * FROM shops WHERE rating > 2 AND name LIKE 'T%'
      In theory it's only a problem when they're on the same field,
      but since applying those on different fields doesn't make any
      sense it's easier if we just disallow it in any case.
      It's OK if it's with an OR (not the same query):
        SELECT * FROM shops WHERE rating > 2 OR name LIKE 'T%'
  */

  if (astOperator === '!=' || astOperator === '<>') {
    if (astValue.type === 'bool') {
      // If the value is a boolean, then just perform a == operation
      // with the negation of the value.
      const negValue: SQL_ValueBool = { type: 'bool', value: !astValue.value };
      return applyCondition(queries, field, '=', negValue);
    } else {
      // The != operator is not supported in Firestore so we
      // split this query in two, one with the < operator and
      // another one with the > operator.
      return [
        ...applyCondition(queries, field, '<', astValue),
        ...applyCondition(queries, field, '>', astValue)
      ];
    }
  } else {
    const value = astValueToNative(astValue);
    const operator = whereFilterOp(astOperator);
    return queries.map(query => query.where(field, operator, value));
  }
}

function whereFilterOp(op: string): firebase.firestore.WhereFilterOp {
  let newOp: firebase.firestore.WhereFilterOp;

  switch (op) {
    case '=':
    case 'IS':
      newOp = '==';
      break;
    case '<':
    case '<=':
    case '>':
    case '>=':
      newOp = op;
      break;
    case 'CONTAINS':
      newOp = 'array-contains';
      break;
    case 'CONTAINS-ANY':
      newOp = 'array-contains-any';
      break;
    case 'NOT':
    case 'NOT CONTAINS':
      throw new Error('"NOT" WHERE operator unsupported');
      break;
    default:
      throw new Error('Unknown WHERE operator');
  }

  return newOp;
}

interface WhereLikeResult {
  beginsWith?: SQL_ValueString;
  endsWith?: SQL_ValueString;
  contains?: SQL_ValueString;
  equals?: SQL_ValueString;
}

function stringASTWhereValue(str: string): SQL_ValueString {
  return {
    type: 'string',
    value: str
  };
}

function parseWhereLike(str: string): WhereLikeResult {
  const result: WhereLikeResult = {};
  const strLength = str.length;

  if (str[0] === '%') {
    if (str[strLength - 1] === '%') {
      result.contains = stringASTWhereValue(str.substr(1, strLength - 2));
    } else {
      result.endsWith = stringASTWhereValue(str.substring(1));
    }
  } else if (str[strLength - 1] === '%') {
    result.beginsWith = stringASTWhereValue(str.substr(0, strLength - 1));
  } else {
    result.equals = stringASTWhereValue(str);
  }

  return result;
}

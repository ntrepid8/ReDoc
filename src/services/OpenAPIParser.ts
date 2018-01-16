import { observable } from 'mobx';
import { resolve as urlResolve } from 'url';

import { OpenAPIRef, OpenAPISchema, OpenAPISpec, Referenced } from '../types';

import { JsonPointer } from '../utils/JsonPointer';
import { isNamedDefinition } from '../utils/openapi';
import { COMPONENT_REGEXP, buildComponentComment } from './MarkdownRenderer';
import { RedocNormalizedOptions } from './RedocNormalizedOptions';
import { appendToMdHeading, isBrowser } from '../utils/';

export type MergedOpenAPISchema = OpenAPISchema & { parentRefs?: string[] };

/**
 * Helper class to keep track of visited references to avoid
 * endless recursion because of circular refs
 */
class RefCounter {
  public _counter = {};

  reset(): void {
    this._counter = {};
  }

  visit(ref: string): void {
    this._counter[ref] = this._counter[ref] ? this._counter[ref] + 1 : 1;
  }

  exit(ref: string): void {
    this._counter[ref] = this._counter[ref] && this._counter[ref] - 1;
  }

  visited(ref: string): boolean {
    return !!this._counter[ref];
  }
}

/**
 * Loads and keeps spec. Provides raw spec operations
 */
export class OpenAPIParser {
  @observable specUrl: string;
  @observable.ref spec: OpenAPISpec;

  constructor(
    spec: OpenAPISpec,
    specUrl: string | undefined,
    private options: RedocNormalizedOptions,
  ) {
    this.validate(spec);
    this.preprocess(spec);

    this.spec = spec;

    const href = isBrowser ? window.location.href : '';
    if (typeof specUrl === 'string') {
      this.specUrl = urlResolve(href, specUrl);
    } else {
      this.specUrl = href;
    }
  }

  private _refCounter: RefCounter = new RefCounter();

  validate(spec: any) {
    if (spec.openapi === undefined) {
      throw new Error('Document must be valid OpenAPI 3.0.0 definition');
    }
  }

  preprocess(spec: OpenAPISpec) {
    if (
      !this.options.noAutoAuth &&
      spec.info &&
      spec.components &&
      spec.components.securitySchemes
    ) {
      // Automatically inject Authentication section with SecurityDefinitions component
      const description = spec.info.description || '';
      const securityRegexp = new RegExp(
        COMPONENT_REGEXP.replace('{component}', '<security-definitions>'),
        'gmi',
      );
      if (!securityRegexp.test(description)) {
        const comment = buildComponentComment('security-definitions');
        spec.info.description = appendToMdHeading(description, 'Authentication', comment);
      }
    }
  }

  /**
   * get spec part by JsonPointer ($ref)
   */
  byRef = <T extends any = any>(ref: string): T | undefined => {
    let res;
    if (this.spec === undefined) return;
    if (ref.charAt(0) !== '#') ref = '#' + ref;
    ref = decodeURIComponent(ref);
    try {
      res = JsonPointer.get(this.spec, ref);
    } catch (e) {
      // do nothing
    }
    return res;
  };

  /**
   * checks if the objectt is OpenAPI reference (containts $ref property)
   */
  isRef(obj: any): obj is OpenAPIRef {
    if (!obj) {
      return false;
    }
    return obj.$ref !== undefined && obj.$ref !== null;
  }

  /**
   * resets visited enpoints. should be run after
   */
  resetVisited() {
    if (__DEV__) {
      // check in dev mode
      for (let k in this._refCounter._counter) {
        if (this._refCounter._counter[k] > 0) {
          console.warn('Not exited reference: ' + k);
        }
      }
    }
    this._refCounter = new RefCounter();
  }

  exitRef<T>(ref: Referenced<T>) {
    if (!this.isRef(ref)) return;
    this._refCounter.exit(ref.$ref);
  }

  /**
   * Resolve given reference object or return as is if it is not a reference
   * @param obj object to dereference
   * @param forceCircular whether to dereference even if it is cirular ref
   */
  deref<T extends object>(obj: OpenAPIRef | T, forceCircular: boolean = false): T {
    if (this.isRef(obj)) {
      const resolved = this.byRef<T>(obj.$ref)!;
      const visited = this._refCounter.visited(obj.$ref);
      this._refCounter.visit(obj.$ref);
      if (visited && !forceCircular) {
        // circular reference detected
        return Object.assign({}, resolved, { 'x-circular-ref': true });
      }
      // deref again in case one more $ref is here
      if (this.isRef(resolved)) {
        const res = this.deref(resolved);
        this.exitRef(resolved);
        return res;
      }
      return resolved;
    }
    return obj;
  }

  /**
   * Merge allOf contsraints.
   * @param schema schema with allOF
   * @param $ref pointer of the schema
   * @param forceCircular whether to dereference children even if it is a cirular ref
   */
  mergeAllOf(
    schema: OpenAPISchema,
    $ref?: string,
    forceCircular: boolean = false,
  ): MergedOpenAPISchema {
    if (schema.allOf === undefined) {
      return schema;
    }

    let receiver: MergedOpenAPISchema = {
      ...schema,
      allOf: undefined,
      parentRefs: [],
    };

    const allOfSchemas = schema.allOf.map(subSchema => {
      const resolved = this.deref(subSchema, forceCircular);
      const subRef = subSchema.$ref || undefined;
      const subMerged = this.mergeAllOf(resolved, subRef, forceCircular);
      receiver.parentRefs!.push(...(subMerged.parentRefs || []));
      return {
        $ref: subRef,
        schema: subMerged,
      };
    });

    for (let { $ref: subSchemaRef, schema: subSchema } of allOfSchemas) {
      if (
        receiver.type !== subSchema.type &&
        receiver.type !== undefined &&
        subSchema.type !== undefined
      ) {
        throw new Error(`Uncopatible types in allOf at "${$ref}"`);
      }

      if (subSchema.type !== undefined) {
        receiver.type = subSchema.type;
      }

      if (subSchema.properties !== undefined) {
        // TODO: merge properties contents
        receiver.properties = {
          ...(receiver.properties || {}),
          ...subSchema.properties,
        };
      }

      if (subSchema.required !== undefined) {
        receiver.required = (receiver.required || []).concat(subSchema.required);
      }

      // merge rest of constraints
      // TODO: do more intelegent merge
      receiver = { ...subSchema, ...receiver };

      if (subSchemaRef) {
        receiver.parentRefs!.push(subSchemaRef);
        if (receiver.title === undefined && isNamedDefinition(subSchemaRef)) {
          receiver.title = JsonPointer.baseName(subSchemaRef);
        }
      }
    }

    // name of definition or title on top level
    if (schema.title === undefined && isNamedDefinition($ref)) {
      receiver.title = JsonPointer.baseName($ref);
    }

    return receiver;
  }

  /**
   * Find all derived definitions among #/components/schemas from any of $refs
   * returns map of definition pointer to definition name
   * @param $refs array of references to find derived from
   */
  findDerived($refs: string[]): Dict<string> {
    const res: Dict<string> = {};
    const schemas = (this.spec.components && this.spec.components.schemas) || {};
    for (let defName in schemas) {
      const def = this.deref(schemas[defName]);
      if (
        def.allOf !== undefined &&
        def.allOf.find(obj => obj.$ref !== undefined && $refs.indexOf(obj.$ref) > -1)
      ) {
        res['#/components/schemas/' + defName] = defName;
      }
    }
    return res;
  }
}
import { LinearSdk, parseLinearError } from "@linear/sdk";
import type { LinearRequest } from "@linear/sdk";
import { membrane } from "./membrane";

const connectionSelector = process.env.MEMBRANE_CONNECTION_SELECTOR ?? "linear";

export class LinearService extends LinearSdk {
  constructor() {
    const request: LinearRequest = async <Response, Variables extends Record<string, unknown>>(
      doc: string,
      variables?: Variables,
    ): Promise<Response> => {
      const { data, errors } = await membrane.connection(connectionSelector).proxy.post("graphql", {
        query: doc,
        variables,
      });

      if (errors && errors.length) {
        throw parseLinearError(errors[0]);
      }

      return data as Response;
    };

    super(request);
  }
}

export const linear = new LinearService();

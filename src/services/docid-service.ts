import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { ItemType } from "../commands/types/ItemType";
import { authentication, AuthenticationSession } from "vscode";
import { HeadersInit } from "node-fetch";
import { ConfigReader } from "../configuration/config-reader";

export interface DocIdResult {
    docId?: string;
    severity?: "error" | "warning";
    message?: string;
}

export class DocIdService {
    public static async getDocId(displayName: string, apiType: ItemType, gitUrl: string): Promise<DocIdResult> {

        // For namespaces, we don't even look them up.
        if (apiType === ItemType.namespace) {
            return { docId: displayName };
        }

        let session: AuthenticationSession | undefined;

        const config = ConfigReader.readConfig();
        if (config.allowGitHubSession) {
            const providerId = "github";
            const accounts = await authentication.getAccounts(providerId);
            if (accounts && accounts.length > 0) {
                session = await authentication.getSession(
                    providerId,
                    ["repo"], {
                    account: accounts[0],
                    createIfNone: true
                });
            }
        }

        const headers: HeadersInit = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            "Content-Type": "application/xml",
        };

        if (session) {
            headers["Authorization"] = `Bearer ${session.accessToken}`;
        }

        const response = await fetch(gitUrl, {
            headers
        });

        if (!response.ok) {

            if (response.status === 404) {
                return {
                    severity: "error",
                    message: `HTTP 404: Unable to retrieve xref metadata for "${displayName}". When this happens, it's usually because the GitHub repo for the API docs is private.`
                };
            }

            return {
                severity: "warning",
                message: `HTTP ${response.status}: Failed to get the DocId for "${displayName}". Attempted fetching [this Raw GitHub URL](${gitUrl}).`
            };
        }

        const text = await response.text();
        const xml = await parseStringPromise(text);

        // Class, struct, interface, or enum.
        if ([ItemType.class, ItemType.struct, ItemType.interface, ItemType.enum].includes(apiType)) {
            const typeSignature = xml.Type.TypeSignature?.find((x: any) => x.$.Language === 'DocId');
            return { docId: typeSignature ? typeSignature.$.Value.substring(2) : null };
        }

        const memberType = apiType;
        const typeName = xml.Type.$.FullName;
        let memberName = displayName.substring(typeName.length + 1).split('(')[0];

        // Constructor or method.
        if (apiType === ItemType.constructor || apiType === ItemType.method) {
            if (apiType === ItemType.constructor) {
                memberName = ".ctor";
            }

            // All overloads.
            if (displayName.endsWith('*')) {
                if (apiType === ItemType.method) {
                    memberName = memberName.substring(0, memberName.length - 1);
                }

                // Match any overload and then modify the DocId.
                const methodOrCtor = xml.Type.Members[0].Member?.find((x: any) =>
                    x.$.MemberName === memberName &&
                    x.MemberType[0] === memberType
                );

                const docId = methodOrCtor.MemberSignature.find((x: any) => x.$.Language === 'DocId').$.Value.substring(2);
                // Replace the parentheses with *.
                return { docId: docId.split('(')[0].concat('*') };
            }

            const paramList = displayName.split('(')[1].slice(0, -1);
            const paramTypes = paramList.length > 0 ? paramList.split(',').map(x => x.trim().split(' ')[0]) : [];
            const numParams = paramTypes.length;

            // No parameters.
            if (numParams === 0) {
                const methodOrCtor = xml.Type.Members[0].Member?.find((x: any) =>
                    x.$.MemberName === memberName &&
                    x.MemberType[0] === memberType &&
                    !x.Parameters.Parameter
                );

                return { docId: methodOrCtor ? methodOrCtor.MemberSignature.find((x: any) => x.$.Language === 'DocId').$.Value.substring(2) : null };
            }

            // With parameters.
            const candidates = xml.Type.Members[0].Member?.filter((x: any) =>
                x.$.MemberName === memberName &&
                x.MemberType[0] === memberType &&
                x.Parameters[0].Parameter?.length === numParams
            );

            for (const candidate of candidates) {
                let paramIndex = 0;
                for (const parameter of candidate.Parameters[0].Parameter) {
                    let xmlType = parameter.$.Type;

                    // Parameter type could be have a generic type argument.
                    // For example: 'System.ReadOnlySpan<System.Char>'.
                    // In this case, the parameter type to match
                    // in the displayName is 'ReadOnlySpan<Char>'.
                    if (xmlType.includes('<')) {
                        const genericTypeArg = xmlType.split('<')[1].split('>')[0];
                        // Remove the namespace of the generic type argument.
                        xmlType = xmlType.replace(genericTypeArg, genericTypeArg.split('.').pop());
                    }

                    if (paramTypes[paramIndex] !== xmlType.split('.').pop()) {
                        break;
                    }

                    paramIndex++;
                }

                if (paramIndex === numParams) {
                    // We found a match.
                    return { docId: candidate.MemberSignature.find((x: any) => x.$.Language === "DocId").$.Value.substring(2) };
                }
            }

            // We didn't find a matching method/constructor.
            return {
                severity: "warning",
                message: `Failed to get the DocId for "${displayName}". Didn't find a matching method/constructor.`
            };
        }

        // Property, Event, or Field.
        if (apiType === ItemType.property || apiType === ItemType.attachedProperty ||
            apiType === ItemType.event || apiType === ItemType.attachedEvent ||
            apiType === ItemType.field) {

            // Special case for "Item" property (which is actually
            // an indexer, not a property. Go figure.)
            // The displayName is "Item[String]" or "Item[Int32]" etc.,
            // but in the ECMAXML, the MemberName is just "Item".
            // And, this "property" also has parameter(s)!
            if (memberName.split('[')[0] === "Item") {
                const paramList = memberName.split('[')[1].slice(0, -1);
                const paramTypes = paramList.length > 0 ? paramList.split(',').map(x => x.trim().split(' ')[0]) : [];

                const candidates = xml.Type.Members[0].Member?.filter((x: any) =>
                    x.$.MemberName === "Item" &&
                    x.MemberType[0] === memberType &&
                    x.Parameters[0].Parameter?.length === paramTypes.length
                );

                for (const candidate of candidates) {
                    let paramIndex = 0;
                    for (const parameter of candidate.Parameters[0].Parameter) {
                        let xmlType = parameter.$.Type;

                        if (paramTypes[paramIndex] !== xmlType.split('.').pop()) {
                            break;
                        }

                        paramIndex++;
                    }

                    if (paramIndex === paramTypes.length) {
                        // We found a match.
                        return { docId: candidate.MemberSignature.find((x: any) => x.$.Language === "DocId").$.Value.substring(2) };
                    }
                }
            } else {
                const member = xml.Type.Members[0].Member?.find((x: any) =>
                    x.$.MemberName === memberName &&
                    x.MemberType[0] === memberType
                );

                return { docId: member ? member.MemberSignature.find((x: any) => x.$.Language === "DocId").$.Value.substring(2) : null };
            }
        }

        // Operator.
        if (apiType === ItemType.operator) {
            const member = xml.Type.Members[0].Member?.find((x: any) =>
                x.$.MemberName === "op_".concat(memberName) &&
                x.MemberType[0] === "Method" // Operators are "methods" in the ECMAXML.
            );

            return { docId: member ? member.MemberSignature.find((x: any) => x.$.Language === "DocId").$.Value.substring(2) : null };
        }

        // We didn't find a matching API.
        return {
            severity: "warning",
            message: `Failed to get the DocId for "${displayName}". Attempted parsing [this Raw GitHub URL](${gitUrl}).`
        };
    }
}

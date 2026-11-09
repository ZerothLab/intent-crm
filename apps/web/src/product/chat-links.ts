/** Only application destinations supported by authorized, structured AI cards. */
export function isChatDestination(href:string) {
  return /^(?:\/customers\/[a-zA-Z0-9_-]+(?:\?(?:focus=(?:fields|facts|runs)|action=[a-zA-Z0-9_-]+))?|\/opportunities\/[a-zA-Z0-9_-]+(?:\?(?:tab=(?:finance|tasks)|focus=advance))?)$/.test(href);
}

patrick conversation

Patrick is building environments for robots and his usual workflow is that he owns a VM that he SSHs into. He has Claude Code's remote control, where he can directly program within that VM.

In his planning process he usually goes pretty specifically into the technical side with Claude and asks to build it out but I think the most important thing here was the iteration process with agents. He relies a lot on artifacts and has Claude generate diagrams based off of mostly technical stuff. For example one time he generated a graph of all the dependencies there and then there was a GitHub connection. He told the agent to remove the GitHub connection right there.

He definitely relies on already generating artifacts and Mermaid diagrams, UML stuff specifically, to think about the technical. He says the temptation is always there to just let the agent run a bit loose just so that it's an easy change. It seems like it's kind of tiring to just constantly be in the loop with context.

He says his biggest challenges right now are mostly shipping to prod. It isn't really a big challenge for him because he doesn't really have too many users. As long as 80% of it works for the couple of users and there is a lot of handholding right now, he is not really concerned if anything breaks. If he had 2,000 users and for more established companies, it could possibly be a bigger problem but 

But yeah in the planning process, he did do a lot of text-based back-and-forth with Claude to draft the plan and then had Claude improve the architecture 

He does say that as of now he doesn't really care about how things are wired though. His main process or his main challenge is just getting more users and just getting things shipped. I think that's an important caveat to note: maybe people don't have the incentive to actually try and learn, maintain, or keep up to date with that backend. If people just prioritize getting things shipped, don't care how things are wired, and don't care that things break occasionally, then that's an important thing to know 


Pat conversation

-> for pat, workflow is usually asking claude to generate mockups, talking with it to refine idea, then letting it build. doesn’t really do any backend planning. Doesn’t really get technical, lets AI handle all of that. 
-> his background is mostly frontend engineering and like c/c++ 
-> His biggest challenge is having observability especially in the building process w/ ai, like being able to see it visually build smth so he could steer it, since he might let it run for an hour and itll produce smth completely wrong. This and he’ll forget he has ultracode on or smth and use it for a small change 
-> For pat, what would be most helpful visually is seeing user flow/journeys in a diagram, possibly defining personas etc. Moreso concerned about the UX flow. 
->Defines like a design bible that outlines the functions of the system and what pages they touch, basically works w/ systems that have gotten so big that you need smth to define the relationships. had claude make it. Says that you don’t often need to understand what goes on in the backend but when you do its tough. 
-  

Vishnu
-> not rly in my icp, has a team which he outsources the work to. when he talks to the team he speaks on more of a semi-technical conceptual level, like what should the agent do, certain state management etc. Was more non technical 
-> I guess for him even though he wasn’t really fit for this I feel like it begs the question of if the models are good enough to just solve the problem of badly engineered systems in general, and then if people care enough to try and fix these systems -> the icp should be people who care about the codebase and want to maintain it. If these people don’t exist then its moreso about the ux. 

Shonn 
-> develops a lot with AI, does a lot of intentional planning in the systems w/ claude, lets it do implementation, and then reviews the engineering afterwards - if its “shit” generally has the review process w/ around 3 agents to stop it from bullshitting
-> To actually test, just tests the app live + sees how its updating on notion (uses that as a system of record for tasks and stuff) to see whether it worked. if it doesn’t asks, it to fix, and then if it can’t fix it in around 2 tries then goes back and looks at it.  But has to run the live tests 
-> says he “doesn’t really have a problem” with AI development, im thinking because he’s pretty confident in his ability to develop w/ AI and think through the systems. 
At least thinks that good design engineering will always be a problem because claude doesn’t have the context that you have, so you always need to maintain a good holistic view of what’s going on and be in the loop in that way 
-> Doesn’t really care how AI fixes it because he’s spent time thinking through the systems, understands that the systems underneath are solid. Doesn’t really care how it fixes it 
-> Thinks the skill itself is a temporary problem in his opinion, but i think he was more hung up on the fact that it was a skill as a medium. But yeah i guess his opinion is that it doesn’t solve a strong enough need for people to pay for it 
-> Does agree that most people don’t really care about the engineering, but maybe that’s a problem on the builder rather than the interface. 
	-> i guess my assumption is that its an interface problem but is it just that people don’t care enough 


Abel: 
-> Said he personally doesn’t need the tool too much, i guess bc he carries a lot of context himself and has equipe (his ide w/ multiple specialized agents) to plan out specs and stuf,  but sees that it could help potentially w/ engineers looking to understand big systems or non technical founders trying to understand. Ie his friend was a google engineer interviewing for waymo, was a PM but in the final round they asked him ot explain the waymo backend and all the APIs and stuff but couldn’t explain how it worked. or if he’s explaining to a technical cofounder, could send a diagram to explain how it would work to more non technical people. 



dhruv 
-> Does contract work for clients, usually specifies what he wants in a plan with claude, does most of the planning w/ edge cases and talks through architecture decisions, especially how to eventually scale it like design choices. Then just lets claude handle the implementation. 
-> Says that the biggest challenge in technical development is what im building - like when his client comes up with a technical change, he has to understand the system in order to actually make the change. Can’t tell claude to just fix it - mainly because he doesn’t trust it fully - and comes from a security background so just always wants to remain in the loop with how its implemented and edge cases and stuff. If he had a diagram to see how it would work it would help. 
-> But when I talked through with him more about how the diagram would actually help him, his idea was have the combination of both frontend user experience + see how its wired on the backend when you press into it. For example, he showed me the dashboard he had of it pulling from different data sources. Would be nice to press on a component in the frontend and see what goes into a specific data source 
-> showed me an example of a mock frontend dashboard and his claude chat where he asks how it sourced different parts of it like KPIs for example and claude has to just give the reasoning. 
-> Thinks edge cases are a very human problem, is doubtful of if claude/AI could ever fully handle all edge cases. I guess it goes back into if ai has the same context as a human.

-> Jay: struggles with the UX flow design. Rather than just prompting claude, telling it whats wrong and asking to re-fix it over and over, asks gpt to map out frontends side by side as mockups and then chooses what he likes and doesn’t like. But just doesnt like hwo there’s no ux judgement built into the ai demos, has to think from first principles as a user. And the iteration process is slow. Said there was a neat tool called 21st or something that pulls from nice website designs or smth Doesn’t really look into the backend at all, thats the role of his technical cofounder, but is owrried about how building something in V1 might be different from v2 or v3, wants to make sure the architecture is scaalble but has no observability. 

-> Dhruv: chimed in to the problem of how his client wanted a data integration change, and hwne he was trying to understand the workflow, gpt just gave him a block of text rather than just showing him the workflow in a diagram. And its the context overloading engs have to do just being presented with a ton of stuff as walls of text. Said good engineers can probably store it but for these guys who are semi technical its a challenge. 


Aditya’s ideas: 
-> user journey, when you ask can show you conceptually what happens -> based on what is pressed etc. kept more non technical 

-> backend codebase -> the overengineering side, building scalable architecture 

Other aditya:
-> biggest challenge is having to use a swiss army knife for everything, ie getting an answer should be a simple one line thing don’t need to wait and then a full paragraph 

Charles:
-> when we talked said that the over engineering problem was definitely prevalent around opus 4.8, but doesn’t think it’s as big of a problem these days, plus the model problem feels very temporary w the observably aspect
-> said he doesn’t really have a big challenge when working w ai, but doesn’t really look at code at all 
-> Think he said smth about planning w fable and then letting it run autonomously, think he said smth about how agents handle the technicals better than humans 

Divam:
-> biggest challenge is agent orchestration, usually fires up around 10 agents manually in separate harnesses, thinks of a task for them, checks up on them one by one
-> says another challenge was understanding code/ PRs, asks claude to spin up diagrams. seems pretty excited when i introduced my tool
-> said my tool is prolly a good code review tool for people pushing code into prod, where it actually matters.
-> small changes matter less but big changes still matter

Adam:
-> works in software development, works with a finance firm/banks to integrate software with them. 
-> workflow usually looks like 30% implementation, 30% working w pms to figure out what to build, 30% evaluating output and stuff, I think he works w finance people to build evals
-> in his workflows biggest challenge is probably verifying the correctness of the numbers, kind of takes a default stance that the agent isn’t fully accurate here, when working with money you need to fully understand where they came from (this is what he said when i asked if he’ll ever just naturally trust the agents bc they’re so good). I think used to like A B test outputs? 
-> When I showed him the tool, he said it might be useful, biggest use case he saw w it was maybe when you’re onboarding someone new into a company and you want to help them understand a codebase, you can use this type of tool. 

Edward:
Talk to Edward and he's working on voice agents for onboarding, building voice agents to help with the onboarding process within companies.

He's the CEO right now. He's also technical: he was an engineer and used to ship more changes but now he currently manages a team and does more product and GTM stuff.

I think when asked about his biggest challenges, he definitely mentioned that the QA bottleneck was the biggest challenge, where he had one person for QA. Right now the process for them is that they ship changes, QA them in a development environment, and then push them out. They're currently working with nine clients.

He says his codebase is pretty mature and big, so it's a big monorepo and it's pretty bloated. Another challenge he mentioned was that agents don't really have the context to work through all of that effectively just because it's so big. Shipping changes can be hard because of that.

On a similar note engineers understand their own components but no one really understands the large codebase as a whole just because it's so big. That's, of course, natural as you build. For him what he was thinking about was that he believes all people on his team should be technical to some degree in terms of understanding the codebase. He would want the salespeople to, instead of asking him how something works or about any bugs, just be able to be at least somewhat technical architecturally in terms of understanding how things work. Same with product people: everyone should be coding and pushing to some degree. He has them on Claude Code and stuff as well.

When I showed him my idea he found it pretty inspiring because he gave me an idea about building a 3-minute video or something as a walkthrough. You could ask a question and it would generate a walkthrough video with UX and frontend as well. It would show you how the frontend works and how the flows work. That would help ground it for more nontechnical people as well if you could incorporate the frontend with the backend.

He thinks the use case for it would just be sharing it with others, whether that's for onboarding, understanding a change that the agent just made in more long-horizon work, or introducing it to more nontechnical people. These were all potential use cases for it.

He actually built his own product where you could ask Claude to generate from one prompt and it would generate a full onboarding video with UX and Slack as a frontend. It just walks through it as an onboarding video. This was purely frontend but it was dynamically generated from one Claude prompt. How they did it was they spun up UX with screen record and then would push that into a video.

I think for external integrations like Slack and email, they would generate a fake Slack and email with fake data and then push that as well. That helps hone in on the point of how their frontend usually works. I'm thinking maybe that's something I could incorporate as well. In general he notes that onboarding is a challenge especially when you get to engineer number 5. But yeah whenever your team is growing, I think it's hard to keep in contact with different people. I think I asked him about this: hypothetically if agents got to the point where they could just be super technical, would you still require people to have a good technical understanding? He mentioned that, not really, as long as you get to the point where you're producing quality output. That's all he cares about.

He thinks that, at the end of the day, the core values he has as a PM are understanding your users, building something with the users, and then still understanding things architecturally. He thinks that is high-level because, let's say, with voice agents, if you want to design a good voice agent system with cascade or speech-to-speech (as he mentioned), that's still a design decision that a human needs to be in the loop for. You need to have human judgment for those design decisions. That's something he believes will always be there. That's where he thinks the value will shift towards. 

But when talking about the tutorial vid thing, it should still be focused on how something works technically that’s smth he still values. And I guess that could be a dynamic vid or presentation 

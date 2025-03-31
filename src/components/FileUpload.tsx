import React, { useState } from 'react';
import { Upload, LogOut, Brain, Lightbulb, Trophy, Search } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import OpenAI from 'openai';
import { ASSISTANTS, type AssistantType, type AnalysisResult } from '../config/assistants';
import type { MindMapData } from '../types/mindmap';
import { MindMap } from './MindMap';

const initialResults: Record<AssistantType, AnalysisResult> = {
  MIND_MAP: { type: 'MIND_MAP', content: '', status: 'idle' },
  INSIGHTS: { type: 'INSIGHTS', content: '', status: 'idle' },
  ACHIEVEMENTS: { type: 'ACHIEVEMENTS', content: '', status: 'idle' },
  RESEARCH_IDEAS: { type: 'RESEARCH_IDEAS', content: '', status: 'idle' },
};

export function FileUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [results, setResults] = useState<Record<AssistantType, AnalysisResult>>(initialResults);
  const { logout } = useAuthStore();
  const [mindMapData, setMindMapData] = useState<MindMapData | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      if (selectedFile.type === "application/pdf") {
        setFile(selectedFile);
        setResults(initialResults);
        setMindMapData(null);
      } else {
        setFile(null);
        setResults({
          ...initialResults,
          MIND_MAP: { ...initialResults.MIND_MAP, status: 'error', error: 'Please upload a PDF file' }
        });
      }
    }
  };

  const processWithAssistant = async (
    openai: OpenAI,
    fileId: string,
    assistantType: AssistantType
  ) => {
    try {
      setResults(prev => ({
        ...prev,
        [assistantType]: { ...prev[assistantType], status: 'loading' }
      }));

      const thread = await openai.beta.threads.create();
      
      const prompts: Record<AssistantType, string> = {
        MIND_MAP: `Analyze this medical research paper and create a mind map in JSON format.

CRITICAL: Return ONLY a valid JSON object with NO additional text or explanation.

Required JSON structure:
{
  "nodes": [
    {
      "id": "unique_string_id",
      "label": "node_text",
      "type": "main" | "subtopic" | "detail",
      "children": [
        {
          "id": "child_id",
          "label": "child_text",
          "type": "subtopic" | "detail",
          "children": []
        }
      ]
    }
  ],
  "relationships": [
    {
      "from": "node_id",
      "to": "node_id",
      "label": "optional_relationship_description"
    }
  ],
  "metadata": {
    "paperTitle": "full_paper_title",
    "authors": ["author1", "author2"],
    "year": 2024,
    "mainTopic": "paper_main_topic"
  }
}

Guidelines:
1. Main sections (Abstract, Methods, Results) should be type "main"
2. Key findings and methodologies should be type "subtopic"
3. Supporting details should be type "detail"
4. Every node must have a unique "id"
5. Include relevant cross-section relationships
6. Ensure all JSON syntax is valid (quotes, commas, brackets)`,
        INSIGHTS: `Extract and analyze the top 10 most significant insights from this medical research paper.

CRITICAL: Format your response as follows:

1. [Main Finding]: Brief description of the primary insight
   - Supporting evidence or statistical significance
   - Clinical or research implications

2. [Main Finding]: Next key insight
   ...

Continue this format for all 10 insights. Each insight should:
- Start with a clear, concise statement
- Include supporting data or evidence
- Explain the significance or implications
- Use bullet points for clarity

DO NOT include any introductory text or conclusions.
Start directly with "1." and end with the last insight.`,

        ACHIEVEMENTS: "Identify and explain the major achievements and innovations presented in this research paper. Focus on what makes these contributions significant to the field.",
        
        RESEARCH_IDEAS: `Based on this paper's findings and limitations, suggest future research directions.

Format your response as follows:

GAPS AND OPPORTUNITIES:
1. [Research Gap]: Description
   - Potential approach to address this gap
   - Expected impact and significance

2. [Research Gap]: Description
   ...

METHODOLOGICAL IMPROVEMENTS:
1. [Method]: Suggested improvement
   - Rationale and potential benefits
   - Implementation considerations

FOLLOW-UP STUDIES:
1. [Study Proposal]: Brief description
   - Key objectives and hypotheses
   - Potential methodology

List at least 3 items under each category. Be specific and actionable.
DO NOT include any introductory or concluding text.`
      };

      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: prompts[assistantType],
        attachments: [{ file_id: fileId, tools: [{ type: "file_search" }] }]
      });

      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: ASSISTANTS[assistantType],
      });

      let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      while (runStatus.status === "queued" || runStatus.status === "in_progress") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);

        if (runStatus.status === "failed") {
          throw new Error(`Analysis failed for ${assistantType}`);
        }
      }

      const messages = await openai.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find((msg) => msg.role === "assistant");

      if (!assistantMessage?.content) {
        throw new Error(`No response received for ${assistantType}`);
      }

      const content = assistantMessage.content
        .map((item) => (item.type === 'text' ? item.text?.value || "" : ""))
        .join("\n\n");

      if (assistantType === 'MIND_MAP') {
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          const jsonStr = jsonMatch ? jsonMatch[0] : content;
          
          const mindMapData = JSON.parse(jsonStr) as MindMapData;
          
          if (!mindMapData.nodes?.length) {
            throw new Error('Mind map must contain at least one node');
          }
          
          if (!Array.isArray(mindMapData.relationships)) {
            throw new Error('Relationships must be an array');
          }
          
          if (!mindMapData.metadata?.paperTitle || !mindMapData.metadata?.mainTopic) {
            throw new Error('Metadata must include paperTitle and mainTopic');
          }
          
          const validateNode = (node: any): void => {
            if (!node.id || typeof node.id !== 'string') {
              throw new Error('Each node must have a string id');
            }
            if (!node.label || typeof node.label !== 'string') {
              throw new Error('Each node must have a string label');
            }
            if (!['main', 'subtopic', 'detail'].includes(node.type)) {
              throw new Error('Invalid node type');
            }
            if (node.children) {
              if (!Array.isArray(node.children)) {
                throw new Error('Children must be an array');
              }
              node.children.forEach(validateNode);
            }
          };
          
          mindMapData.nodes.forEach(validateNode);
          
          setMindMapData(mindMapData);
          setResults(prev => ({
            ...prev,
            [assistantType]: { 
              type: assistantType, 
              content: 'Mind map generated successfully', 
              status: 'complete' 
            }
          }));
        } catch (err) {
          throw new Error(
            err instanceof Error 
              ? `Invalid mind map data: ${err.message}`
              : 'Failed to parse mind map data'
          );
        }
      } else if (assistantType === 'INSIGHTS' || assistantType === 'RESEARCH_IDEAS') {
        // Validate the format of insights and research ideas
        if (!content.trim()) {
          throw new Error(`No ${assistantType === 'INSIGHTS' ? 'insights' : 'research ideas'} found in the response`);
        }

        // Check if the content follows the numbered format
        if (!content.match(/^\d+\./m)) {
          throw new Error(`Invalid ${assistantType === 'INSIGHTS' ? 'insights' : 'research ideas'} format`);
        }

        setResults(prev => ({
          ...prev,
          [assistantType]: { 
            type: assistantType, 
            content: content.trim(), 
            status: 'complete' 
          }
        }));
      } else {
        setResults(prev => ({
          ...prev,
          [assistantType]: { type: assistantType, content, status: 'complete' }
        }));
      }
    } catch (err) {
      setResults(prev => ({
        ...prev,
        [assistantType]: {
          ...prev[assistantType],
          status: 'error',
          error: err instanceof Error ? err.message : 'Analysis failed'
        }
      }));
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    try {
      const openai = new OpenAI({
        apiKey: import.meta.env.VITE_OPENAI_API_KEY,
        dangerouslyAllowBrowser: true,
      });

      const fileUpload = await openai.files.create({
        file,
        purpose: "assistants",
      });

      await Promise.all(
        Object.keys(ASSISTANTS).map((type) => 
          processWithAssistant(openai, fileUpload.id, type as AssistantType)
        )
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Upload failed';
      setResults(prev => 
        Object.keys(prev).reduce((acc, key) => ({
          ...acc,
          [key]: { ...prev[key as AssistantType], status: 'error', error }
        }), {} as Record<AssistantType, AnalysisResult>)
      );
    }
  };

  const ResultCard = ({ type, icon: Icon, title, description }: {
    type: AssistantType;
    icon: typeof Brain;
    title: string;
    description: string;
  }) => {
    const result = results[type];
    
    return (
      <div className="glass-card p-6 hover-scale">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full glass-card flex items-center justify-center">
            <Icon size={20} className="text-blue-400" />
          </div>
          <h2 className="text-lg font-medium text-white">{title}</h2>
        </div>
        <div className="text-white/70">
          {result.status === 'loading' ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/20 border-t-white"></div>
              Analyzing...
            </div>
          ) : result.status === 'error' ? (
            <div className="text-red-400">{result.error}</div>
          ) : result.status === 'complete' ? (
            type === 'MIND_MAP' && mindMapData ? (
              <MindMap data={mindMapData} />
            ) : (
              <div className="whitespace-pre-wrap">{result.content}</div>
            )
          ) : (
            description
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_center,_#1a1a2a_0%,_#0a0a14_100%)] py-8">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-semibold text-white">
            Medical Research Analyzer
          </h1>
          <button
            onClick={logout}
            className="primary-button bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700"
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="glass-card p-6">
            <div className="border border-white/10 rounded-lg p-8 text-center">
              <input
                type="file"
                accept=".pdf"
                onChange={handleFileChange}
                className="hidden"
                id="file-upload"
              />
              <label
                htmlFor="file-upload"
                className="cursor-pointer flex flex-col items-center gap-4"
              >
                <div className="w-16 h-16 rounded-full glass-card flex items-center justify-center">
                  <Upload size={24} className="text-blue-400" />
                </div>
                <span className="text-white text-lg">
                  {file ? file.name : 'Upload Research Paper (PDF)'}
                </span>
              </label>
              {file && (
                <button
                  onClick={handleUpload}
                  disabled={Object.values(results).some(r => r.status === 'loading')}
                  className="primary-button mt-6 mx-auto"
                >
                  <Brain size={18} />
                  Analyze Paper
                </button>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <ResultCard
              type="MIND_MAP"
              icon={Brain}
              title="Mind Map Analysis"
              description="Generate comprehensive mind maps from research papers"
            />
            <ResultCard
              type="INSIGHTS"
              icon={Lightbulb}
              title="Key Insights"
              description="Extract and analyze key research findings"
            />
            <ResultCard
              type="ACHIEVEMENTS"
              icon={Trophy}
              title="Research Impact"
              description="Identify significant breakthroughs and contributions"
            />
            <ResultCard
              type="RESEARCH_IDEAS"
              icon={Search}
              title="Future Directions"
              description="Discover potential research opportunities"
            />
          </div>
        </div>
      </div>
    </div>
  );
}